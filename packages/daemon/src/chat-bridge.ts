import { createInterface } from 'node:readline'
import { ChatConnectionError, NativeChatClient } from './local-chat-client.js'
import { DaemonState } from './state.js'

/** Estados del broker que un reintento no repara: sin autorización, sesión inexistente, cerrada o ubicación no disponible. */
const FATAL_STATUSES = [401, 403, 404, 409, 410]
const RETRY_MS = 5000
/** Tras cerrarse stdin (la sesión terminó), lo pendiente se entrega durante este tiempo como máximo; luego el bridge sale. */
const DRAIN_CAP_MS = 5 * 60_000
const LIFECYCLE = ["HubPromptSubmit", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"]
const fatal = (error: unknown): boolean => error instanceof ChatConnectionError && FATAL_STATUSES.includes(error.status)

/** Child of the OpenCode plugin. Its pipe lifetime is the session's listener lifetime. */
export async function runChatBridge(stateDir:string,agentId:string) {
  const state=new DaemonState(stateDir)
  if(state.loadSnapshot(agentId)?.['cli_kind']!=='opencode')throw new Error('Este bridge requiere OpenCode.')
  const controller=new AbortController(),lines=createInterface({input:process.stdin})
  let client:NativeChatClient|undefined,listener:Promise<void>|undefined
  let chain=Promise.resolve()
  let ended=false
  const output=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n')
  const stop=()=>controller.abort()
  const pause=()=>new Promise<void>(resolve=>{
    const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve()}
    const timer=setTimeout(done,RETRY_MS);controller.signal.addEventListener('abort',done,{once:true})
  })
  // El core se reinicia al actualizar la app: un fallo de red o un 5xx se reintenta; sólo un rechazo real corta el bridge.
  const register=async(target:NativeChatClient)=>{
    for(;;){
      try{return await target.start()}
      catch(error){if(fatal(error)||controller.signal.aborted)throw error;await pause()}
    }
  }
  // Los eventos de lifecycle cambian la autoridad de la sesión en el broker: se entregan en orden y se reintentan cada 5 s
  // mientras el core no responde. Sólo un rechazo real (401/403/404/409/410) o una parada dura los abandona.
  const deliver=async(target:NativeChatClient,event:string)=>{
    for(;;){
      try{await target.send(event);return}
      catch(error){if(fatal(error))throw error;if(controller.signal.aborted)return;await pause()}
    }
  }
  process.once('SIGTERM',stop);process.once('SIGINT',stop);process.stdout.on('error',stop)
  // El plugin cierra stdin al terminar la sesión: se vacía la cola (incluido un SessionEnd pendiente) antes de salir.
  let drained=false
  lines.on('close',()=>{
    const cap=setTimeout(stop,DRAIN_CAP_MS);cap.unref()
    void chain.then(async()=>{if(client&&!ended&&!controller.signal.aborted){await deliver(client,'SessionEnd');ended=!controller.signal.aborted}}).catch(()=>{}).finally(()=>{drained=true;clearTimeout(cap);stop()})
  })
  lines.on('line',line=>{
    chain=chain.then(async()=>{
      if(controller.signal.aborted)return
      if(line.length>16384)throw new Error('Evento demasiado grande')
      const input=JSON.parse(line)
      if(!client) {
        if(typeof input.session_id!=='string' || !input.session_id || typeof input.cwd!=='string')throw new Error('Sesión inválida')
        client=new NativeChatClient(state,agentId,input.session_id,input.cwd,'opencode_prompt')
        const registration=await register(client)
        output({context:client.context(),session:registration.session})
        listener=client.listen(async text=>{output({text})},controller.signal).catch(()=>{output({error:'Se perdió la conexión de colaboración.'});stop()})
      } else if(LIFECYCLE.includes(input.event)) {
        await deliver(client,input.event)
        if(input.event==='SessionEnd'&&!controller.signal.aborted){ended=true;stop()}
      }
    }).catch(()=>{output({error:'No se pudo registrar o actualizar la sesión de colaboración.'});stop()})
  })
  try {
    await new Promise<void>(resolve=>{controller.signal.addEventListener('abort',()=>resolve(),{once:true});if(controller.signal.aborted)resolve()})
    lines.close();await chain;await listener
    // Parada dura (SIGTERM, tubería rota): un último intento, sin reintentos.
    if(client&&!ended&&!drained)await client.send('SessionEnd').catch(()=>{})
  } finally {process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);process.stdout.removeListener('error',stop)}
  return 0
}
