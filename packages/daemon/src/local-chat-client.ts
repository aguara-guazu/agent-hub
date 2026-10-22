import type { UsageQuotaBinding, UsageQuotaObservation } from '@agenthub/shared'
import { createHmac } from 'node:crypto'
import { inspectNativeProcess, orcaWorkspaceId } from '@agenthub/gateway'
import type { DaemonState } from './state.js'

export type ChatTransport = 'opencode_prompt' | 'acp_prompt' | 'antigravity_stream' | 'codex_appserver' | 'tui_prompt'

/** A connection to the local broker, owned by one native conversation. Never polls a model. */
export class NativeChatClient {
  readonly key: string
  private readonly url: URL
  private readonly token: string
  private readonly started = new Date().toISOString()
  private processInfo: { process_id:number; process_started:string } | undefined
  constructor(private readonly state: DaemonState, readonly agentId: string, readonly nativeId: string, readonly cwd: string, readonly transport: ChatTransport) {
    const credentials = state.loadCredentials(), snapshot = state.loadSnapshot(agentId)
    const servers = snapshot?.['servers'] as { tools?:{name:string}[] }[] | undefined
    if (!credentials || !servers?.some(s=>s.tools?.some(t=>t.name==='chat_join'))) throw new Error('Habilitá colaboración local para este agente en Agent Hub.')
    this.url = new URL('/api/memory/chat/native',credentials.controlPlaneUrl)
    if (!['127.0.0.1','localhost','[::1]'].includes(this.url.hostname)) throw new Error('La colaboración requiere un Hub local.')
    this.token = credentials.token
    this.key = createHmac('sha256',this.token).update(JSON.stringify([agentId,nativeId])).digest('hex')
  }
  async start(pid = process.pid) {
    const info = await inspectNativeProcess(pid)
    if (info) this.processInfo = {process_id:pid,process_started:info.started}
    return this.send('SessionStart')
  }
  async send(event: string, signal?: AbortSignal): Promise<any> {
    const timeout = AbortSignal.timeout(event==='Watch' ? 30000 : 5000)
    const response = await fetch(this.url,{method:'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},
      body:JSON.stringify({agent_id:this.agentId,native_id:this.nativeId,cwd:this.cwd,orca_workspace_id:orcaWorkspaceId(),session_key:this.key,
        event,at:new Date().toISOString(),transport:this.transport,watch_started:this.started,...this.processInfo}),
      signal:signal ? AbortSignal.any([signal,timeout]) : timeout})
    if (!response.ok) throw new ChatConnectionError(response.status)
    return response.json()
  }
  usageEnabled():boolean {
    const servers=this.state.loadSnapshot(this.agentId)?.['servers'] as {tools?:{name:string}[]}[] | undefined
    return !!servers?.some(server=>server.tools?.some(tool=>tool.name==='usage_status'))
  }
  private async usage(payload:Record<string,unknown>,signal?:AbortSignal) {
    if(!this.usageEnabled())throw new ChatConnectionError(403)
    const response=await fetch(new URL('/api/memory/usage/native',this.url),{method:'POST',
      headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},
      body:JSON.stringify({agent_id:this.agentId,native_id:this.nativeId,session_key:this.key,...payload}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(3500)]):AbortSignal.timeout(3500)})
    if(!response.ok)throw new ChatConnectionError(response.status)
    return response.json()
  }
  async bindUsage(provider:string, accountRef?:string, sampleStartedAt=new Date().toISOString(),profileRef?:string,signal?:AbortSignal):Promise<UsageQuotaBinding> {
    const result=await this.usage({action:'bind',provider,account_ref:accountRef,sample_started_at:sampleStartedAt,profile_ref:profileRef},signal)
    return result.binding
  }
  async reportUsage(binding:UsageQuotaBinding,observation:UsageQuotaObservation,signal?:AbortSignal):Promise<void> {
    await this.usage({action:'observe',binding,observation},signal)
  }
  context() {
    return `Agent Hub: conservá tu identidad y session_key=${this.key}; usala en memory_chat_*. Aplicá local-collaboration; cargala sólo si falta su contexto. Si no tenés guía vigente o cambió guidance_version, recuperala con memory_chat_join. Si needs_nickname=true, elegí tu nick antes de escribir; al reanudar conservalo. Leé inbox al iniciar/reanudar, ante avisos o al recuperar conexión. Verificá líder y alcance en la guía; respondé en el hilo correspondiente y atendé la mención al resolverla. No hagas polling ni crees canales sin pedido explícito. El líder transmite sólo permisos reales de la persona; siguen vigentes las aprobaciones de esta CLI.`
  }
  async listen(deliver: (text:string) => Promise<void>, signal: AbortSignal, includeContext=true) {
    while (!signal.aborted) {
      try {
        const result = await this.send('Watch',signal)
        if (result.closed || result.session?.closed_at) throw new ChatConnectionError(410)
        if (result.messages?.length || result.bootstrap) await deliver(includeContext?`${result.context}\n${this.context()}`:result.context)
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof ChatConnectionError && [401,403,404,409,410].includes(error.status)) throw error
        // The durable broker retries unconsumed deliveries. A disconnect is never a receipt.
        await new Promise<void>(resolve=>{
          const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve()}
          const timer=setTimeout(finish,5000); signal.addEventListener('abort',finish,{once:true})
          if(signal.aborted)finish()
        })
      }
    }
  }
}
export class ChatConnectionError extends Error {
  constructor(readonly status:number) { super(status===409 ? 'La ubicación de colaboración no está disponible, el canal virtual fue cerrado o la ruta Git no es un worktree válido.' : `El Hub rechazó la conexión de colaboración (${status}).`) }
}
