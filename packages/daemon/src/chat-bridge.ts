import { createHash, randomBytes } from "node:crypto"
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { ChatConnectionError, NativeChatClient } from "./local-chat-client.js"
import { DaemonState } from "./state.js"

/** Estados del broker que un reintento no repara: sin autorización, sesión inexistente, cerrada o ubicación no disponible. */
const FATAL_STATUSES = [401, 403, 404, 409, 410]
const RETRY_MS = 5000
const LIFECYCLE = ["HubPromptSubmit", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"]
const fatal = (error: unknown): boolean => error instanceof ChatConnectionError && FATAL_STATUSES.includes(error.status)

interface PendingEnd { schema: 1; agent_id: string; session_id: string; cwd: string }

async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, "r")
  try { await handle.sync() } finally { await handle.close() }
}

/** Child of the OpenCode plugin. Its pipe lifetime is the session's listener lifetime. */
export async function runChatBridge(stateDir:string,agentId:string) {
  const state=new DaemonState(stateDir)
  if(state.loadSnapshot(agentId)?.["cli_kind"]!=="opencode")throw new Error("Este bridge requiere OpenCode.")
  const controller=new AbortController(),lines=createInterface({input:process.stdin})
  let client:NativeChatClient|undefined,listener:Promise<void>|undefined
  let chain=Promise.resolve()
  let ended=false
  const output=(value:unknown)=>process.stdout.write(JSON.stringify(value)+"\n")
  const stop=()=>controller.abort()
  const pause=()=>new Promise<void>(resolve=>{
    const done=()=>{clearTimeout(timer);controller.signal.removeEventListener("abort",done);resolve()}
    const timer=setTimeout(done,RETRY_MS);controller.signal.addEventListener("abort",done,{once:true})
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

  // SessionEnd es el único evento que no se puede reconstruir después: queda en disco antes del primer intento y se borra
  // sólo al entregarse o ante un rechazo fatal. Un SIGKILL o el cierre del host lo dejan para el próximo bridge del host.
  const pendingDir=join(stateDir,"chat-bridge","pending")
  const pendingPath=(sessionId:string)=>join(pendingDir,createHash("sha256").update(JSON.stringify([agentId,sessionId])).digest("hex")+".json")
  const persistEnd=async(record:PendingEnd)=>{
    await mkdir(pendingDir,{recursive:true,mode:0o700})
    const path=pendingPath(record.session_id),temp=`${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
    const handle=await open(temp,"w",0o600)
    try{await handle.writeFile(JSON.stringify(record));await handle.sync()}finally{await handle.close()}
    await rename(temp,path)
    await fsyncPath(pendingDir)
  }
  const deliverEnd=async(target:NativeChatClient,record:PendingEnd)=>{
    try{await deliver(target,"SessionEnd")}
    catch(error){if(!fatal(error))return}
    if(controller.signal.aborted)return
    await rm(pendingPath(record.session_id),{force:true})
    await fsyncPath(pendingDir).catch(()=>{})
  }
  const drainPending=async()=>{
    let names:string[]
    try{names=await readdir(pendingDir)}catch{return}
    for(const name of names){
      if(controller.signal.aborted)return
      if(!name.endsWith(".json"))continue
      try{
        const record=JSON.parse(await readFile(join(pendingDir,name),"utf8")) as PendingEnd
        if(record.schema!==1||record.agent_id!==agentId||typeof record.session_id!=="string"||typeof record.cwd!=="string")continue
        await deliverEnd(new NativeChatClient(state,agentId,record.session_id,record.cwd,"opencode_prompt"),record)
      }catch{/* se conserva: el próximo bridge lo reintenta */}
    }
  }
  const endSession=async(target:NativeChatClient,sessionId:string,cwd:string)=>{
    const record:PendingEnd={schema:1,agent_id:agentId,session_id:sessionId,cwd}
    await persistEnd(record)
    await deliverEnd(target,record)
    ended=!controller.signal.aborted
  }
  const pendingDrain=drainPending()

  process.once("SIGTERM",stop);process.once("SIGINT",stop);process.stdout.on("error",stop)
  let sessionId="",sessionCwd=""
  // El plugin cierra stdin al terminar la sesión: se vacía la cola y se entrega el SessionEnd antes de salir, sin tope de tiempo.
  lines.on("close",()=>{
    void chain.then(async()=>{if(client&&!ended&&!controller.signal.aborted)await endSession(client,sessionId,sessionCwd)}).catch(()=>{}).finally(()=>{void pendingDrain.finally(stop)})
  })
  lines.on("line",line=>{
    chain=chain.then(async()=>{
      if(controller.signal.aborted)return
      if(line.length>16384)throw new Error("Evento demasiado grande")
      const input=JSON.parse(line)
      if(!client) {
        if(typeof input.session_id!=="string" || !input.session_id || typeof input.cwd!=="string")throw new Error("Sesión inválida")
        sessionId=input.session_id;sessionCwd=input.cwd
        client=new NativeChatClient(state,agentId,input.session_id,input.cwd,"opencode_prompt")
        const registration=await register(client)
        output({context:client.context(),session:registration.session})
        listener=client.listen(async text=>{output({text})},controller.signal).catch(()=>{output({error:"Se perdió la conexión de colaboración."});stop()})
      } else if(input.event==="SessionEnd") {
        await endSession(client,sessionId,sessionCwd)
        if(!controller.signal.aborted)await pendingDrain
        stop()
      } else if(LIFECYCLE.includes(input.event)) {
        await deliver(client,input.event)
      }
    }).catch(()=>{output({error:"No se pudo registrar o actualizar la sesión de colaboración."});stop()})
  })
  try {
    await new Promise<void>(resolve=>{controller.signal.addEventListener("abort",()=>resolve(),{once:true});if(controller.signal.aborted)resolve()})
    lines.close();await chain;await listener
  } finally {process.removeListener("SIGTERM",stop);process.removeListener("SIGINT",stop);process.stdout.removeListener("error",stop)}
  return 0
}
