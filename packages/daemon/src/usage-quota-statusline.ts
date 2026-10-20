import { cliProcess } from './local-chat-hook.js'
import { NativeChatClient } from './local-chat-client.js'
import { DaemonState } from './state.js'
import { claudeQuotas } from './usage-quota-adapters.js'
import { withQuotaLease } from './usage-quota-collector.js'

/** Called by Claude's own statusline. No transcript, credentials or prompt content leaves the process. */
export async function reportClaudeStatusline(stateDir:string,agentId:string,raw:unknown):Promise<string> {
  if(!raw || typeof raw!=='object' || Array.isArray(raw))return ''
  const input=raw as Record<string,any>,state=new DaemonState(stateDir)
  if(state.loadSnapshot(agentId)?.['cli_kind']!=='claude_code')return ''
  const tui=process.env.AGENTHUB_TUI_AGENT===agentId?process.env.AGENTHUB_TUI_SESSION:undefined
  const nativeId=tui ?? input.session_id,cwd=input.cwd ?? input.workspace?.current_dir
  if(typeof nativeId!=='string' || !nativeId || typeof cwd!=='string' || !cwd)return ''
  const sampleStartedAt=new Date().toISOString()
  const observations=claudeQuotas(input),broker=new NativeChatClient(state,agentId,nativeId,cwd,'tui_prompt')
  // A session-scoped lease prevents stream rendering from flooding the Hub. Account scope is unknown.
  await withQuotaLease(stateDir,JSON.stringify(['claude-statusline',agentId,nativeId]),async()=>{
    if(!tui){const owner=await cliProcess('claude_code');if(!owner)return;await broker.start(owner.process_id)}
    const binding=await broker.bindUsage('anthropic',undefined,sampleStartedAt)
    for(const observation of observations)await broker.reportUsage(binding,observation)
  })
  const windows=observations[0]!.windows
  return windows.length?'Hub · '+windows.map(w=>`${w.id==='five_hour'?'5h':w.id==='seven_day'?'7d':'gasto'} ${w.used}%`).join(' · '):'Hub · cuota desconocida'
}
