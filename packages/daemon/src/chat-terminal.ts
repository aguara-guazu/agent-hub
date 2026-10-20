import { startQuotaCollector } from './usage-quota-collector.js'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { NativeChatClient } from './local-chat-client.js'
import { ChatProtocol } from './chat-protocol.js'
import { DaemonState } from './state.js'

export const chatInvocation = (kind:string, extra:string[], resume?:string): {command:string;args:string[];format:'acp'|'antigravity'|'codex'} => {
  if(kind==='codex_cli')return {command:'codex',args:['app-server',...extra],format:'codex'}
  if(kind==='gemini_cli')return {command:'gemini',args:['--acp',...extra],format:'acp'}
  if(kind==='kiro')return {command:'kiro-cli',args:['acp',...extra],format:'acp'}
  if(kind==='antigravity')return {command:'agy',args:['--input-format','stream-json','--output-format','stream-json',...(resume?['--conversation',resume]:[]),...extra],format:'antigravity'}
  throw new Error('La terminal conectada admite Codex, Gemini CLI, Kiro y Antigravity CLI. Claude y OpenCode se conectan desde sus terminales habituales.')
}

/** Resolve native binaries and npm's Gemini entry without executing a Windows .cmd through a shell. */
export function chatExecutable(command:string,searchPath:string,platform=process.platform) {
  const directories=searchPath.split(platform==='win32'?';':':').filter(Boolean)
  for(const directory of directories) {
    const binary=join(directory,command+(platform==='win32'?'.exe':''))
    if(existsSync(binary))return {command:binary,prefix:[] as string[]}
    if(['gemini','codex'].includes(command) && platform==='win32') {
      const pkg=join(directory,command==='codex'?'node_modules/@openai/codex':'node_modules/@google/gemini-cli')
      try {
        const metadata=JSON.parse(readFileSync(join(pkg,'package.json'),'utf8'))
        const bin=typeof metadata.bin==='string'?metadata.bin:metadata.bin?.[command]
        if(typeof bin==='string' && existsSync(join(pkg,bin)))return {command:process.execPath,prefix:[join(pkg,bin)]}
      } catch { /* Continue to the next installed location. */ }
    }
  }
  return {command,prefix:[] as string[]}
}

/** Serializes human input and broker deliveries; a failure cannot replay a partly executed turn. */
export class ConnectedChatSession {
  private tail:Promise<void>=Promise.resolve()
  private stopped=false
  constructor(readonly protocol:ChatProtocol,readonly broker:NativeChatClient) {}
  submit(text:string,automatic=false) {
    const task=this.tail.then(async()=>{
      if(this.stopped)throw new Error('La sesión está cerrada.')
      await this.broker.send(automatic?'HubPromptSubmit':'UserPromptSubmit')
      try {
        const result=await this.protocol.prompt(`${this.broker.context()}\n\n${text}`)
        await this.broker.send(result?.stopReason==='cancelled' || result?.stopReason==='refusal' ? 'Interrupt':'Stop')
      } catch(error) {
        await this.broker.send('StopFailure').catch(()=>{})
        throw error
      }
    })
    this.tail=task.catch(()=>{})
    return task
  }
  async close() {
    this.stopped=true
    await this.protocol.close()
    await this.tail
    await this.broker.send('SessionEnd').catch(()=>{})
  }
}

/** A small terminal front end for the CLIs' supported persistent protocols. */
export async function runChatTerminal(stateDir:string,agentId:string,extra:string[]=[],resume?:string) {
  const state=new DaemonState(stateDir),snapshot=state.loadSnapshot(agentId)
  if(!snapshot)throw new Error('Sincronizá este agente con Agent Hub antes de abrir la terminal conectada.')
  const kind=String(snapshot['cli_kind']),invocation=chatInvocation(kind,extra,resume),cwd=process.cwd()
  // Check policy before even starting a native process. Registration uses its real ID later.
  new NativeChatClient(state,agentId,'preflight',cwd,invocation.format==='codex'?'codex_appserver':invocation.format==='acp'?'acp_prompt':'antigravity_stream')
  const terminal=createInterface({input:process.stdin,output:process.stdout,terminal:Boolean(process.stdin.isTTY)})
  const controller=new AbortController()
  let permissionReply:((line:string)=>void)|undefined
  let session:ConnectedChatSession|undefined
  let listener:Promise<void>|undefined
  let protocol:ChatProtocol|undefined
  let closing:Promise<void>|undefined
  let stopQuotas:(()=>Promise<void>)|undefined
  let inputEnded=false
  const say=(text:string)=>process.stdout.write(text)
  const report=(error:unknown)=>process.stderr.write(`\n${error instanceof Error?error.message:String(error)}\n`)
  const queued:string[]=[]
  const close=()=> closing ??= Promise.resolve().then(async()=>{
    inputEnded=true;controller.abort();permissionReply?.('');terminal.close()
    if(session)await session.close();else await protocol?.close()
    await stopQuotas?.();await listener?.catch(()=>{})
  })
  const exit=()=>{void close()}
  const interrupt=()=>{
    permissionReply?.('')
    try{protocol?.cancel()}catch(error){report(error)}
    void session?.broker.send('Interrupt').catch(report)
    say('\nTurno cancelado. /exit para cerrar.\n> ')
  }
  terminal.on('SIGINT',interrupt)
  process.once('SIGTERM',exit)
  terminal.on('close',()=>{inputEnded=true;exit()})
  const submit=(text:string)=>void session!.submit(text).catch(report).finally(()=>{if(!inputEnded)say('\n> ')})
  terminal.on('line',line=>{
    if(permissionReply){permissionReply(line);return}
    if(line.trim()==='/exit'){exit();return}
    if(!line.trim())return
    if(!session)queued.push(line);else submit(line)
  })
  try {
    const executablePath=[process.env.PATH,join(homedir(),'.local/bin'),
      ...(process.platform==='win32'?[process.env.APPDATA && join(process.env.APPDATA,'npm'),process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA,'agy/bin')]:['/opt/homebrew/bin','/usr/local/bin'])].filter(Boolean).join(delimiter)
    const executable=chatExecutable(invocation.command,executablePath)
    protocol=new ChatProtocol(invocation.format,executable.command,[...executable.prefix,...invocation.args],cwd,say,async params=>{
      await session?.broker.send('Interrupt').catch(report)
      const options=params.options as {optionId:string;name:string;kind:string}[]
      if(!process.stdin.isTTY || inputEnded || !Array.isArray(options))return {outcome:{outcome:'cancelled'}}
      say(`\nPermiso solicitado: ${params.toolCall?.title ?? 'herramienta'}\n${options.map((o,i)=>`${i+1}. ${o.name}`).join('\n')}\nElegí un número; Enter cancela: `)
      const answer=await new Promise<string>(resolve=>{permissionReply=resolve})
      permissionReply=undefined
      const selected=/^[1-9]\d*$/.test(answer.trim())?options[Number(answer.trim())-1]:undefined
      if(!selected)return {outcome:{outcome:'cancelled'}}
      await session?.broker.send('HubPromptSubmit').catch(report)
      return {outcome:{outcome:'selected',optionId:selected.optionId}}
    },{...process.env,PATH:executablePath,...(executable.prefix.length?{ELECTRON_RUN_AS_NODE:'1'}:{})})
    void protocol.closed.then(exit)
    const mcpServers=[{name:'hub',command:process.execPath,args:[fileURLToPath(new URL('./cli.js',import.meta.url)),'gateway','--agent',agentId,'--state-dir',stateDir],env:[{name:'ELECTRON_RUN_AS_NODE',value:'1'}]}]
    const nativeId=await protocol.start(cwd,mcpServers,resume)
    if(inputEnded)return 0
    const broker=new NativeChatClient(state,agentId,nativeId,cwd,invocation.format==='codex'?'codex_appserver':invocation.format==='acp'?'acp_prompt':'antigravity_stream')
    const registration=await broker.start()
    session=new ConnectedChatSession(protocol,broker)
    stopQuotas=startQuotaCollector({root:state.root,cli:kind,command:executable.command,prefix:executable.prefix,args:extra,cwd,env:process.env,broker,signal:controller.signal,protocol})
    say(`\n${registration.session.label} · ${cwd}\nSesión ${nativeId}. Escucha activa; /exit para cerrar.\n> `)
    listener=broker.listen(text=>session!.submit(text,true),controller.signal).catch(error=>{report(error);exit()})
    for(const line of queued)submit(line)
    await protocol.closed
    return 0
  } finally {
    await close();process.removeListener('SIGTERM',exit);terminal.removeListener('SIGINT',interrupt)
  }
}
