import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { InstalledQuotaClient } from './usage-quota-installed.js'
import { DaemonState } from './state.js'
import { claudeQuotas, antigravityQuotas, quotaProvider } from './usage-quota-adapters.js'
import { chatExecutable } from './chat-terminal.js'
import { quotaProfileRef, withQuotaLease } from './usage-quota-collector.js'

/** Called by Claude's own statusline. No transcript, credentials or prompt content leaves the process. */
export async function reportClaudeStatusline(stateDir:string,agentId:string,raw:unknown):Promise<string> {
  if(!raw || typeof raw!=='object' || Array.isArray(raw))return ''
  const input=raw as Record<string,any>,state=new DaemonState(stateDir)
  const cli=String(state.loadSnapshot(agentId)?.['cli_kind'])
  if(!['claude_code','antigravity'].includes(cli))return ''
  const tui=process.env.AGENTHUB_TUI_AGENT===agentId?process.env.AGENTHUB_TUI_SESSION:undefined
  // Antigravity exposes quota before creating a conversation; registration must not block telemetry.
  const nativeId=cli==='antigravity'?'installed-profile':tui ?? (input.session_id ?? input.conversation_id),cwd=input.cwd ?? input.workspace?.current_dir
  if(typeof nativeId!=='string' || !nativeId || typeof cwd!=='string' || !cwd)return ''
  const executable=chatExecutable(cli==='antigravity'?'agy':'claude',process.env.PATH ?? '')
  const profileRef=quotaProfileRef(cli,executable.command,process.env,cwd)
  const sampleStartedAt=new Date().toISOString()
  const observations=cli==='antigravity'?antigravityQuotas(input):claudeQuotas(input),broker=new InstalledQuotaClient(state,agentId)
  if(!broker.usageEnabled())return ''
  // Sessions using the same profile share a telemetry lease; account identity remains explicitly unknown.
  await withQuotaLease(stateDir,JSON.stringify([cli+'-statusline',profileRef]),async()=>{
    if(!broker.usageEnabled())return
    const directory=join(stateDir,'usage-statusline'),path=join(directory,profileRef+'.json')
    mkdirSync(directory,{recursive:true,mode:0o700})
    let samples:Record<string,string>={}
    try {samples=JSON.parse(readFileSync(path,'utf8'))} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    const session=createHash('sha256').update(nativeId).digest('hex')
    const apiDuration=input.cost?.total_api_duration_ms
    // Ignore wall-clock/session duration, Vim, prompt ids and all non-quota presentation fields.
    const fingerprint=createHash('sha256').update(JSON.stringify({
      quotas:observations.map(o=>({pool:o.pool_id,windows:o.windows,complete:o.complete})),
      api_cursor:typeof apiDuration==='number' && Number.isFinite(apiDuration) && apiDuration>0?apiDuration:null,
    })).digest('hex')
    if(samples[session]===fingerprint)return
    // Keep replay detection bounded; if full, fail closed instead of evicting live-session fingerprints.
    if(!samples[session] && Object.keys(samples).length>=4096)return
    const signal=AbortSignal.timeout(8000)
    const binding=await broker.bindUsage(quotaProvider(cli),undefined,sampleStartedAt,profileRef,signal)
    for(const observation of observations)await broker.reportUsage(binding,observation,signal)
    samples[session]=fingerprint
    const temporary=path+'.tmp'
    writeFileSync(temporary,JSON.stringify(samples),{mode:0o600});renameSync(temporary,path)

  })
  if(cli==='antigravity')return ''
  const windows=observations[0]!.windows
  return windows.length?'Hub · '+windows.map(w=>`${w.id==='five_hour'?'5h':w.id==='seven_day'?'7d':'gasto'} ${w.used}%`).join(' · '):'Hub · cuota desconocida'
}
