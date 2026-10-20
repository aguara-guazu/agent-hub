import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ChatProtocol } from './chat-protocol.js'
import type { NativeChatClient } from './local-chat-client.js'
import { codexAccountId, codexQuotas, kiroQuotas, kiroRateLimit, kiroUsageAdvertised, opaqueQuotaAccount, quotaProvider, unknownQuota } from './usage-quota-adapters.js'

/** Cross-process lease: four agents sharing one profile do not run four account probes. */
export async function withQuotaLease(root:string,profile:string,collect:()=>Promise<void>,now=Date.now()):Promise<boolean> {
  const directory=join(root,'usage-probes'),key=createHash('sha256').update(profile).digest('hex')
  mkdirSync(directory,{recursive:true,mode:0o700})
  const lock=join(directory,key+'.lock'),schedule=join(directory,key+'.json')
  try { if(now-statSync(lock).mtimeMs>60000)rmSync(lock,{recursive:true,force:true}) } catch { /* no stale lease */ }
  try { mkdirSync(lock,{mode:0o700}) } catch { return false }
  try {
    let previous:{next?:number;failures?:number}={}
    try { previous=JSON.parse(readFileSync(schedule,'utf8')) } catch { /* first sample */ }
    if(typeof previous.next==='number' && previous.next>now)return false
    // Reserve before native I/O. A crashed collector cannot immediately cause a retry storm.
    writeFileSync(schedule,JSON.stringify({next:now+120000,failures:previous.failures ?? 0}),{mode:0o600})
    try {
      await collect()
      writeFileSync(schedule,JSON.stringify({next:Date.now()+120000,failures:0}),{mode:0o600})
    } catch {
      const failures=Math.min((previous.failures ?? 0)+1,5)
      writeFileSync(schedule,JSON.stringify({next:Date.now()+Math.min(1800000,120000*2**failures),failures}),{mode:0o600})
    }
    return true
  } finally {rmSync(lock,{recursive:true,force:true})}
}

export async function collectProtocolQuota(protocol:ChatProtocol,cli:string,broker:NativeChatClient):Promise<void> {
  const sampleStartedAt=new Date().toISOString(),init=await protocol.initialize(5000)
  if(cli==='codex_cli') {
    const before=codexAccountId(await protocol.request('account/read',{refreshToken:false},5000))
    const accountRef=before?opaqueQuotaAccount('openai',before):undefined
    const binding=await broker.bindUsage('openai',accountRef,sampleStartedAt)
    const raw=await protocol.request('account/rateLimits/read',{},5000)
    const after=codexAccountId(await protocol.request('account/read',{refreshToken:false},5000))
    if(before!==after || (before && typeof raw?.accountId==='string' && raw.accountId!==before))return
    for(const observation of codexQuotas(raw,accountRef))await broker.reportUsage(binding,observation)
  } else if(cli==='kiro') {
    const binding=await broker.bindUsage('kiro',undefined,sampleStartedAt)
    const observations=kiroUsageAdvertised(init)
      ? kiroQuotas(await protocol.request('_kiro/account/getUsage',{},5000))
      : [unknownQuota('kiro','kiro-acp','native_usage_not_advertised')]
    for(const observation of observations)await broker.reportUsage(binding,observation)
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

export function quotaProfileKey(cli:string,command:string,env:NodeJS.ProcessEnv,cwd?:string):string {
  const overrides:string[]=[]
  // Project config may select a different account/provider. Stat only: never read secrets/config contents.
  if(cli==='codex_cli' && cwd)for(let dir=resolve(cwd);;dir=dirname(dir)) {
    const config=join(dir,'.codex','config.toml')
    try {const info=statSync(config);if(info.isFile())overrides.push(config+':'+info.mtimeMs)} catch { /* absent */ }
    if(dirname(dir)===dir)break
  }
  return JSON.stringify([cli,command,env.HOME,env.USERPROFILE,env.CODEX_HOME,env.KIRO_CONFIG_DIR,overrides])
}

/** Owns only short-lived metadata subprocesses; never prompts or writes into a native terminal. */
export function startQuotaCollector(options:{root:string;cli:string;command:string;prefix:string[];args:string[];cwd:string;env:NodeJS.ProcessEnv;broker:NativeChatClient;signal:AbortSignal;protocol?:ChatProtocol}) {
  let lastRateLimit=0
  let timer:ReturnType<typeof setTimeout>|undefined,running:Promise<unknown>|undefined,child:ChatProtocol|undefined
  const {cli,broker,signal}=options
  if(!['codex_cli','kiro'].includes(cli))return async()=>{}
  // The profile key is opaque on disk and deliberately independent of agent/session/worktree.
  const profile=quotaProfileKey(cli,options.command,options.env,options.cwd)
  const sample=async()=>{
    if(signal.aborted || running)return
    clearTimeout(timer)
    running=withQuotaLease(options.root,profile,async()=>{
      const supported=['codex_cli','kiro'].includes(cli) && (options.protocol || quotaProbeCompatibleArgs(cli,options.args))
      if(!supported) {
        const binding=await broker.bindUsage(quotaProvider(cli))
        await broker.reportUsage(binding,unknownQuota(cli,cli==='codex_cli'?'codex-app-server':'kiro-acp','native_probe_unsupported'))
        return
      }
      const protocol=options.protocol ?? new ChatProtocol(cli==='codex_cli'?'codex':'acp',options.command,
        [...options.prefix,...(cli==='codex_cli'?['app-server']:['acp','--agent-engine=v3'])],options.cwd,()=>{},async()=>({outcome:{outcome:'cancelled'}}),options.env)
      if(!options.protocol)child=protocol
      const deadline=!options.protocol?setTimeout(()=>{void protocol.close()},25000):undefined
      try {await collectProtocolQuota(protocol,cli,broker)} finally {clearTimeout(deadline);if(!options.protocol){await protocol.close();child=undefined}}
    }).catch(()=>{}).finally(()=>{running=undefined})
    await running
    if(!signal.aborted)timer=setTimeout(()=>{void sample()},60000)
  }
  const stop=()=>{clearTimeout(timer);if(child)void child.close()}
  signal.addEventListener('abort',stop,{once:true})
  if(options.protocol)options.protocol.onQuotaChanged=(method,params)=>{
    if(method==='_kiro/error/rate_limit' && cli==='kiro' && params.sessionId===options.protocol!.sessionId) {
      if(Date.now()-lastRateLimit<60000)return
      lastRateLimit=Date.now()
      void broker.bindUsage('kiro').then(binding=>broker.reportUsage(binding,kiroRateLimit())).catch(()=>{})
    } else void sample()
  }
  void sample()
  return async()=>{stop();signal.removeEventListener('abort',stop);if(options.protocol)options.protocol.onQuotaChanged=undefined;await running}
}
