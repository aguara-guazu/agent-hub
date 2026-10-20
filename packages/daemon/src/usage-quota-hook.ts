import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isAbsolute, delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { inspectNativeProcess } from '@agenthub/gateway'
import { NativeChatClient } from './local-chat-client.js'
import { DaemonState } from './state.js'
import { ChatProtocol } from './chat-protocol.js'
import { chatExecutable } from './chat-terminal.js'
import { collectProtocolQuota, quotaProfileKey, withQuotaLease } from './usage-quota-collector.js'

/** A hook does not expose argv structurally. Refuse known account/routing overrides rather than guess them. */
export function quotaHookProfileSafe(command:string):boolean {
  const rest=command.replace(/(?:-c|--config)\s+["']?model_reasoning_effort=["']?(?:low|medium|high|xhigh|max)["']?["']?/g,'')
  return !/(?:^|\s)["']?(?:--profile|-p|--config|-c|--remote|--oss|--local-provider|--config-file)(?:[=\s"']|$)/.test(rest)
}
/** The hook has already registered this native session. Its short metadata helper never joins a new one. */
export function launchQuotaHookProbe(state:DaemonState,agentId:string,nativeId:string,cwd:string,owner:{process_id:number;process_started:string}) {
  const child=spawn(process.execPath,[fileURLToPath(new URL('./cli.js',import.meta.url)),'usage-probe','--agent',agentId,'--state-dir',state.root],
    {env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','ignore','ignore'],detached:true,windowsHide:true})
  child.once('error',()=>{});child.stdin?.on('error',()=>{})
  child.stdin?.end(JSON.stringify({native_id:nativeId,cwd,...owner}));child.unref()
}
export async function runQuotaHookProbe(stateDir:string,agentId:string,raw:unknown):Promise<void> {
  if(!raw || typeof raw!=='object' || Array.isArray(raw))return
  const input=raw as Record<string,unknown>
  if(typeof input.native_id!=='string' || !input.native_id || input.native_id.length>512 || typeof input.cwd!=='string' || !isAbsolute(input.cwd) ||
    typeof input.process_id!=='number' || !Number.isSafeInteger(input.process_id) || input.process_id<=1 || typeof input.process_started!=='string')return
  const owner=await inspectNativeProcess(input.process_id)
  if(!owner || owner.started!==input.process_started || !/(?:^|[/\\])codex(?:\.exe)?(?:\s|$)/.test(owner.command.split(/\s+-c\s+/)[0]!) ||
    /\bapp-server\b/.test(owner.command) || !quotaHookProfileSafe(owner.command))return
  const state=new DaemonState(stateDir)
  if(state.loadSnapshot(agentId)?.['cli_kind']!=='codex_cli')return
  const broker=new NativeChatClient(state,agentId,input.native_id,input.cwd,'tui_prompt')
  const searchPath=[process.env.PATH,join(homedir(),'.local/bin'),...(process.platform==='win32'?[process.env.APPDATA&&join(process.env.APPDATA,'npm')]:['/opt/homebrew/bin','/usr/local/bin'])].filter(Boolean).join(delimiter)
  const executable=chatExecutable('codex',searchPath),env={...process.env,PATH:searchPath,...(executable.prefix.length?{ELECTRON_RUN_AS_NODE:'1'}:{})}
  await withQuotaLease(stateDir,quotaProfileKey('codex_cli',executable.command,env,input.cwd),async()=>{
    const protocol=new ChatProtocol('codex',executable.command,[...executable.prefix,'app-server'],input.cwd as string,()=>{},async()=>({}),env)
    const deadline=setTimeout(()=>{void protocol.close()},25000)
    try {await collectProtocolQuota(protocol,'codex_cli',broker)} finally {clearTimeout(deadline);await protocol.close()}
  })
}
