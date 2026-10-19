import { createInterface } from 'node:readline'
import { NativeChatClient } from './local-chat-client.js'
import { DaemonState } from './state.js'

/** Child of the OpenCode plugin. Its pipe lifetime is the session's listener lifetime. */
export async function runChatBridge(stateDir:string,agentId:string) {
  const state=new DaemonState(stateDir)
  if(state.loadSnapshot(agentId)?.['cli_kind']!=='opencode')throw new Error('Este bridge requiere OpenCode.')
  const controller=new AbortController(),lines=createInterface({input:process.stdin})
  let client:NativeChatClient|undefined,listener:Promise<void>|undefined
  let chain=Promise.resolve()
  const output=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n')
  const stop=()=>controller.abort()
  process.once('SIGTERM',stop);process.once('SIGINT',stop);process.stdout.on('error',stop)
  lines.on('close',stop)
  lines.on('line',line=>{
    chain=chain.then(async()=>{
      if(controller.signal.aborted)return
      if(line.length>16384)throw new Error('Evento demasiado grande')
      const input=JSON.parse(line)
      if(!client) {
        if(typeof input.session_id!=='string' || !input.session_id || typeof input.cwd!=='string')throw new Error('Sesión inválida')
        client=new NativeChatClient(state,agentId,input.session_id,input.cwd,'opencode_prompt')
        const registration=await client.start()
        output({context:client.context(),session:registration.session})
        listener=client.listen(async text=>{output({text})},controller.signal).catch(()=>{output({error:'Se perdió la conexión de colaboración.'});stop()})
      } else if(['HubPromptSubmit','UserPromptSubmit','Stop','StopFailure','SessionEnd'].includes(input.event)) {
        await client.send(input.event)
        if(input.event==='SessionEnd')stop()
      }
    }).catch(()=>{output({error:'No se pudo registrar o actualizar la sesión de colaboración.'});stop()})
  })
  try {
    await new Promise<void>(resolve=>{controller.signal.addEventListener('abort',()=>resolve(),{once:true});if(controller.signal.aborted)resolve()})
    lines.close();await chain;await listener
    await client?.send('SessionEnd').catch(()=>{})
  } finally {process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);process.stdout.removeListener('error',stop)}
  return 0
}
