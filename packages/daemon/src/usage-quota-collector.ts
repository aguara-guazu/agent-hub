import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync, renameSync, unlinkSync, rmdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ChatProtocol } from './chat-protocol.js'
import type { NativeChatClient } from './local-chat-client.js'
import { codexAccountId, codexQuotas, kiroQuotas, kiroRateLimit, kiroUsageAdvertised, opaqueQuotaAccount, quotaProvider, unknownQuota } from './usage-quota-adapters.js'

/** Cross-process lease: four agents sharing one profile do not run four account probes. */
export async function withQuotaLease(root:string,profile:string,collect:()=>Promise<void>,now=Date.now()):Promise<boolean> {
  const directory=join(root,'usage-probes'),key=createHash('sha256').update(profile).digest('hex')
  mkdirSync(directory,{recursive:true,mode:0o700})
  const lock=join(directory,key+'.lock'),schedule=join(directory,key+'.json')
  const owner=randomUUID(),ownerPath=join(lock,owner)
  try {
    if(now-statSync(lock).mtimeMs>60000) {
      const retired=lock+'.retired-'+owner
      renameSync(lock,retired);rmSync(retired,{recursive:true,force:true})
    }
  } catch { /* no stale lease or another process recovered it */ }
  try {mkdirSync(lock,{mode:0o700});writeFileSync(ownerPath,'',{flag:'wx',mode:0o600})} catch {return false}
  const owns=()=>existsSync(ownerPath)
  try {
    let previous:{next?:number;failures?:number}={}
    try { previous=JSON.parse(readFileSync(schedule,'utf8')) } catch { /* first sample */ }
    if(typeof previous.next==='number' && previous.next>now)return false
    // Reserve before native I/O. A crashed collector cannot immediately cause a retry storm.
    writeFileSync(schedule,JSON.stringify({next:now+120000,failures:previous.failures ?? 0}),{mode:0o600})
    try {
      await collect()
      if(owns())writeFileSync(schedule,JSON.stringify({next:Date.now()+120000,failures:0}),{mode:0o600})
    } catch {
      const failures=Math.min((previous.failures ?? 0)+1,5)
      if(owns())writeFileSync(schedule,JSON.stringify({next:Date.now()+Math.min(1800000,120000*2**failures),failures}),{mode:0o600})
    }
    return true
  } finally {
    // Never recursively remove a lock: after takeover this path may belong to another collector.
    try {unlinkSync(ownerPath)} catch { /* lease was replaced */ }
    try {rmdirSync(lock)} catch { /* a replacement owner keeps its token inside */ }
  }
}

export async function collectProtocolQuota(protocol:ChatProtocol,cli:string,broker:NativeChatClient,profileRef?:string,signal?:AbortSignal):Promise<void> {
  signal?.throwIfAborted()
  if(!broker.usageEnabled())return
  const sampleStartedAt=new Date().toISOString(),init=await protocol.initialize(5000,signal)
  signal?.throwIfAborted()
  if(cli==='codex_cli') {
    const before=codexAccountId(await protocol.request('account/read',{refreshToken:false},5000,signal))
    const accountRef=before?opaqueQuotaAccount('openai',before):undefined
    const binding=await broker.bindUsage('openai',accountRef,sampleStartedAt,profileRef,signal)
    const raw=await protocol.request('account/rateLimits/read',{},5000,signal)
    signal?.throwIfAborted()
    const after=codexAccountId(await protocol.request('account/read',{refreshToken:false},5000,signal))
    if(before!==after || (before && typeof raw?.accountId==='string' && raw.accountId!==before)) {
      // A confirmed account switch invalidates the old profile binding immediately, even without new quota data.
      // A contradictory response cannot identify the effective account; detach rather than preserve stale availability.
      const finalRef=before!==after && after?opaqueQuotaAccount('openai',after):undefined
      await broker.bindUsage('openai',finalRef,new Date(Math.max(Date.now(),Date.parse(sampleStartedAt)+1)).toISOString(),profileRef,signal)
      return
    }
    for(const observation of codexQuotas(raw,accountRef)){signal?.throwIfAborted();await broker.reportUsage(binding,observation,signal)}
  } else if(cli==='kiro') {
    const binding=await broker.bindUsage('kiro',undefined,sampleStartedAt,profileRef,signal)
    const observations=kiroUsageAdvertised(init)
      ? kiroQuotas(await protocol.request('_kiro/account/getUsage',{},5000,signal))
      : [unknownQuota('kiro','kiro-acp','native_usage_not_advertised')]
    for(const observation of observations){signal?.throwIfAborted();await broker.reportUsage(binding,observation,signal)}
  }
}

/** Only flags that cannot change auth/profile are ignored for the account probe. Unknown flags fail closed. */
export function quotaProbeCompatibleArgs(cli:string,args:string[]):boolean {
  const values=cli==='kiro'?['--model','--effort','--agent']:['--model','-m']
  for(let i=0;i<args.length;i++) {
    const arg=args[i]!
    if(cli==='codex_cli' && ['-c','--config'].includes(arg) && /^model_reasoning_effort=(?:"(?:low|medium|high|xhigh|max)"|(?:low|medium|high|xhigh|max))$/.test(args[i+1] ?? '')){i++;continue}
    if(values.some(flag=>arg.startsWith(flag+'=')))continue
    if(values.includes(arg) && args[i+1] && !args[i+1]!.startsWith('-')){i++;continue}
    return false
  }
  return true
}

function quotaProfileParts(cli:string,command:string,env:NodeJS.ProcessEnv,cwd:string|undefined,includeMtime:boolean):unknown[] {
  const overrides:string[]=[]
  const relative=cli==='codex_cli'?['.codex/config.toml']:cli==='claude_code'?['.claude/settings.json','.claude/settings.local.json']:[]
  // Presence/path only establishes configuration scope. No settings content, tokens or transcripts are read.
  if(cwd && relative.length)for(let dir=resolve(cwd);;dir=dirname(dir)) {
    for(const name of relative) {
      const config=join(dir,name)
      try {const info=statSync(config);if(info.isFile())overrides.push(includeMtime?config+':'+info.mtimeMs:config)} catch { /* absent */ }
    }
    if(dirname(dir)===dir)break
  }
  return [cli,command,env.HOME,env.USERPROFILE,env.CODEX_HOME,env.CLAUDE_CONFIG_DIR,env.KIRO_CONFIG_DIR,overrides.sort()]
}
/** Stable across turns, sessions and settings edits; distinct project configuration paths isolate bindings. */
export const quotaProfileRef=(cli:string,command:string,env:NodeJS.ProcessEnv,cwd?:string):string=>
  createHash('sha256').update(JSON.stringify(quotaProfileParts(cli,command,env,cwd,false))).digest('hex')
/** Lease alone includes mtime to refresh after settings edits without changing the profile identity. */
export const quotaProfileKey=(cli:string,command:string,env:NodeJS.ProcessEnv,cwd?:string):string=>
  JSON.stringify(quotaProfileParts(cli,command,env,cwd,true))

/** Owns only short-lived metadata subprocesses; never prompts or writes into a native terminal. */
export function startQuotaCollector(options:{root:string;cli:string;command:string;prefix:string[];args:string[];cwd:string;env:NodeJS.ProcessEnv;broker:NativeChatClient;signal:AbortSignal;protocol?:ChatProtocol}) {
  let lastRateLimit=0
  let timer:ReturnType<typeof setTimeout>|undefined,running:Promise<unknown>|undefined,child:ChatProtocol|undefined
  const {cli,broker,signal}=options
  if(!['codex_cli','kiro'].includes(cli))return async()=>{}
  // The profile key is opaque on disk and deliberately independent of agent/session/worktree.
  const sample=async()=>{
    if(signal.aborted || running)return
    clearTimeout(timer)
    if(!broker.usageEnabled()){timer=setTimeout(()=>{void sample()},60000);return}
    const profile=quotaProfileKey(cli,options.command,options.env,options.cwd)
    const profileRef=quotaProfileRef(cli,options.command,options.env,options.cwd)
    running=withQuotaLease(options.root,profile,async()=>{
      if(!broker.usageEnabled())return
      const budget=AbortSignal.any([signal,AbortSignal.timeout(25000)])
      budget.throwIfAborted()
      const supported=['codex_cli','kiro'].includes(cli) && (options.protocol || quotaProbeCompatibleArgs(cli,options.args))
      if(!supported) {
        const binding=await broker.bindUsage(quotaProvider(cli),undefined,new Date().toISOString(),profileRef,budget)
        await broker.reportUsage(binding,unknownQuota(cli,cli==='codex_cli'?'codex-app-server':'kiro-acp','native_probe_unsupported'),budget)
        return
      }
      const protocol=options.protocol ?? new ChatProtocol(cli==='codex_cli'?'codex':'acp',options.command,
        [...options.prefix,...(cli==='codex_cli'?['app-server']:['acp','--agent-engine=v3'])],options.cwd,()=>{},async()=>({outcome:{outcome:'cancelled'}}),options.env)
      if(!options.protocol)child=protocol
      const cancel=()=>{if(!options.protocol)void protocol.close()}
      budget.addEventListener('abort',cancel,{once:true})
      try {await collectProtocolQuota(protocol,cli,broker,profileRef,budget)} finally {budget.removeEventListener('abort',cancel);if(!options.protocol){await protocol.close();child=undefined}}
    }).catch(()=>{}).finally(()=>{running=undefined})
    await running
    if(!signal.aborted)timer=setTimeout(()=>{void sample()},60000)
  }
  const stop=()=>{clearTimeout(timer);if(child)void child.close()}
  signal.addEventListener('abort',stop,{once:true})
  if(options.protocol)options.protocol.onQuotaChanged=(method,params)=>{
    if(method==='_kiro/error/rate_limit' && cli==='kiro' && params.sessionId===options.protocol!.sessionId) {
      if(!broker.usageEnabled() || Date.now()-lastRateLimit<60000)return
      lastRateLimit=Date.now()
      void broker.bindUsage('kiro',undefined,new Date().toISOString(),quotaProfileRef(cli,options.command,options.env,options.cwd),signal).then(binding=>broker.reportUsage(binding,kiroRateLimit(),signal)).catch(()=>{})
    } else void sample()
  }
  void sample()
  return async()=>{stop();signal.removeEventListener('abort',stop);if(options.protocol)options.protocol.onQuotaChanged=undefined;await running}
}
