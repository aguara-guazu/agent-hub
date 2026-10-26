import { readHttpQuota } from './usage-quota-http.js'
import { quotaProvider } from './usage-quota-adapters.js'
import { readClaudeUsage } from './usage-quota-claude.js'
import { claudeControlQuotas } from './usage-quota-adapters.js'
import type { UsageQuotaBinding, UsageQuotaObservation } from '@agenthub/shared'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { DaemonState } from './state.js'
import { ChatProtocol } from './chat-protocol.js'
import { chatExecutable } from './chat-terminal.js'
import { collectProtocolQuota, quotaProfileKey, quotaProfileRef, withQuotaLease } from './usage-quota-collector.js'

/** Machine-authenticated telemetry, independent of conversation registration or nickname. */
export class InstalledQuotaClient {
  constructor(private state:DaemonState,readonly agentId:string) {}
  usageEnabled():boolean {
    const servers=this.state.loadSnapshot(this.agentId)?.['servers'] as {tools?:{name:string}[]}[]|undefined
    return !!servers?.some(s=>s.tools?.some(t=>t.name==='usage_status'))
  }
  private async send(payload:Record<string,unknown>,signal?:AbortSignal):Promise<any> {
    if(!this.usageEnabled())throw new Error('usage_disabled')
    const credentials=this.state.loadCredentials()
    if(!credentials)throw new Error('usage_not_enrolled')
    const url=new URL('/api/memory/usage/installed',credentials.controlPlaneUrl)
    if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('usage_requires_local_hub')
    const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${credentials.token}`,'Content-Type':'application/json'},
      body:JSON.stringify({agent_id:this.agentId,...payload}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)})
    if(!response.ok)throw new Error(`usage_http_${response.status}`)
    return response.json()
  }
  async bindUsage(provider:string,accountRef?:string,sampleStartedAt=new Date().toISOString(),profileRef?:string,signal?:AbortSignal):Promise<UsageQuotaBinding> {
    return (await this.send({action:'bind',provider,account_ref:accountRef,profile_ref:profileRef,sample_started_at:sampleStartedAt},signal)).binding
  }
  async reportUsage(binding:UsageQuotaBinding,observation:UsageQuotaObservation,signal?:AbortSignal):Promise<void> {
    await this.send({action:'observe',binding,observation},signal)
  }
}

/** Refresh the installed default profiles even before any team has been launched. */
export async function collectInstalledQuota(state:DaemonState,agentId:string,home=homedir()):Promise<void> {
  const cli=String(state.loadSnapshot(agentId)?.['cli_kind'])
  if(!['codex_cli','claude_code','kiro','gemini_cli','opencode'].includes(cli))return
  const broker=new InstalledQuotaClient(state,agentId)
  if(!broker.usageEnabled())return
  if(cli==='gemini_cli' || cli==='opencode') {
    await withQuotaLease(state.root,quotaProfileKey(cli,cli,process.env,home),async()=>{
      const signal=AbortSignal.timeout(20000),sampleStartedAt=new Date().toISOString()
      const observations=await readHttpQuota(cli,home,signal)
      if(!broker.usageEnabled())return
      const binding=await broker.bindUsage(quotaProvider(cli),undefined,sampleStartedAt,quotaProfileRef(cli,cli,process.env,home),signal)
      for(const observation of observations)await broker.reportUsage(binding,observation,signal)
    });return
  }
  const searchPath=[process.env.PATH,join(home,'.local/bin'),...(process.platform==='win32'?[]:['/opt/homebrew/bin','/usr/local/bin'])].filter(Boolean).join(delimiter)
  const executable=chatExecutable(cli==='codex_cli'?'codex':cli==='kiro'?'kiro-cli':'claude',searchPath),env={...process.env,PATH:searchPath,...(executable.prefix.length?{ELECTRON_RUN_AS_NODE:'1'}:{})}
  await withQuotaLease(state.root,quotaProfileKey(cli,executable.command,env,home),async()=>{
    if(!broker.usageEnabled())return
    if(cli==='claude_code') {
      const signal=AbortSignal.timeout(20000),sampleStartedAt=new Date().toISOString()
      const raw=await readClaudeUsage(executable.command,executable.prefix,home,env,signal)
      const binding=await broker.bindUsage('anthropic',undefined,sampleStartedAt,quotaProfileRef(cli,executable.command,env,home),signal)
      for(const observation of claudeControlQuotas(raw))await broker.reportUsage(binding,observation,signal)
      return
    }
    const protocol=new ChatProtocol(cli==='kiro'?'acp':'codex',executable.command,[...executable.prefix,...(cli==='kiro'?['acp','--agent-engine=v3']:['app-server'])],home,()=>{},async()=>({}),env)
    const signal=AbortSignal.timeout(35000),abort=()=>{void protocol.close()}
    signal.addEventListener('abort',abort,{once:true})
    try {await collectProtocolQuota(protocol,cli,broker,quotaProfileRef(cli,executable.command,env,home),signal)}
    finally{signal.removeEventListener('abort',abort);await protocol.close()}
  })
}
