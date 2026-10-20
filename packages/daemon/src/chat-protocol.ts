import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

type Packet = Record<string, any>
export type PermissionPrompt = (params: Packet) => Promise<Packet>

/** One persistent process and one native session. Requests are never replayed after a broken pipe. */
export class ChatProtocol {
  readonly child: ChildProcessWithoutNullStreams
  readonly closed: Promise<void>
  sessionId = ''
  private initialized: Packet | undefined
  onQuotaChanged: ((method:string, params:Packet) => void) | undefined
  private seq = 0
  private pending = new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>()
  private dead = false
  private streamTurn: {resolve:(value:any)=>void;reject:(error:Error)=>void} | undefined
  private init: {resolve:(value:string)=>void;reject:(error:Error)=>void} | undefined
  private streamReady: Promise<string>
  private turnId = ''
  constructor(readonly format:'acp'|'antigravity'|'codex', command:string, args:string[], cwd:string,
    private output:(text:string)=>void, private permission:PermissionPrompt, env = process.env) {
    this.streamReady = new Promise((resolve,reject)=>{this.init={resolve,reject}})
    // ACP does not use the stream handshake; still observe rejection on spawn failure.
    void this.streamReady.catch(()=>{})
    this.child=spawn(command,args,{cwd,env,stdio:'pipe',windowsHide:true})
    this.child.stdin.on('error',error=>this.fail(error))
    this.child.stderr.on('data',chunk=>output(String(chunk)))
    const lines=createInterface({input:this.child.stdout})
    lines.on('line',line=>{
      try { void this.receive(JSON.parse(line)).catch(error=>this.fail(error)) }
      catch { this.fail(new Error('La CLI emitió una respuesta inválida para el protocolo de chat.')) }
    })
    this.closed=new Promise(resolve=>{
      this.child.once('error',error=>{this.fail(error);resolve()})
      this.child.once('close',(code,signal)=>{lines.close();this.fail(new Error(`La CLI terminó (${signal ?? code}).`));resolve()})
    })
  }
  private fail(error:Error) {
    if(this.dead)return
    this.dead=true
    for(const request of this.pending.values())request.reject(error)
    this.pending.clear();this.streamTurn?.reject(error);this.streamTurn=undefined;this.init?.reject(error)
    if(this.child.exitCode===null && !this.child.killed)this.child.kill('SIGTERM')
  }
  private write(packet:Packet) {
    if(this.dead || !this.child.stdin.writable)throw new Error('La sesión de CLI está cerrada.')
    this.child.stdin.write(JSON.stringify(packet)+'\n')
  }
  async request(method:string,params:Packet,timeout=30000):Promise<any> {
    const id=++this.seq
    let timer:ReturnType<typeof setTimeout>|undefined
    try {
      return await new Promise((resolve,reject)=>{
        this.pending.set(id,{resolve,reject})
        if(timeout)timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`La CLI no respondió a ${method}.`))},timeout)
        try { this.write({jsonrpc:'2.0',id,method,params}) } catch(error) {this.pending.delete(id);reject(error)}
      })
    } finally { clearTimeout(timer) }
  }
  private async receive(packet:Packet) {
    if(packet.id===undefined && ['account/rateLimits/updated','_kiro/error/rate_limit'].includes(packet.method)) {
      // An observer must never break or settle a conversation. It refreshes via native reads.
      try { this.onQuotaChanged?.(packet.method,packet.params ?? {}) } catch { /* telemetry is optional */ }
      return
    }
    if(this.format==='codex' && packet.method) {
      const params=packet.params ?? {}
      if(packet.id!==undefined) {
        if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(packet.method)) {
          const result=params.threadId===this.sessionId ? await this.permission({
            toolCall:{title:[params.command ?? 'Cambios de archivos',params.reason,params.cwd].filter(Boolean).join('\n')},
            options:[{optionId:'accept',name:'Permitir una vez',kind:'allow_once'},{optionId:'decline',name:'Rechazar',kind:'reject_once'}]
          }) : undefined
          const chosen=result?.outcome?.outcome==='selected' ? result.outcome.optionId : 'cancel'
          this.write({id:packet.id,result:{decision:['accept','decline'].includes(chosen)?chosen:'cancel'}})
        } else this.write({id:packet.id,error:{code:-32601,message:'Solicitud no soportada por esta terminal del Hub'}})
      } else if(params.threadId===this.sessionId) {
        if(packet.method==='turn/started')this.turnId=params.turn?.id ?? ''
        if(packet.method==='item/agentMessage/delta')this.output(params.delta ?? '')
        if(packet.method==='item/started' && ['commandExecution','fileChange','mcpToolCall'].includes(params.item?.type))this.output(`\n[${params.item.command ?? params.item.tool ?? params.item.type}]\n`)
        if(packet.method==='turn/completed' && params.turn?.id===this.turnId) {
          const turn=this.streamTurn;this.streamTurn=undefined;this.turnId=''
          if(params.turn.status==='failed')turn?.reject(new Error(params.turn.error?.message ?? 'Codex no pudo completar el turno.'))
          else turn?.resolve({stopReason:params.turn.status==='interrupted'?'cancelled':'end_turn'})
        }
      }
      return
    }
    if(this.format==='antigravity') {
      if(packet.event==='init') {
        if(typeof packet.conversation_id!=='string' || !packet.conversation_id)throw new Error('Antigravity no informó conversation_id.')
        this.sessionId=packet.conversation_id;this.init?.resolve(this.sessionId)
      }
      if(packet.event==='step_update' && packet.step_update?.text_delta)this.output(packet.step_update.text_delta)
      if(packet.event==='result') {
        if(packet.result?.conversation_id!==this.sessionId)throw new Error('Antigravity cambió de conversación inesperadamente.')
        const turn=this.streamTurn;this.streamTurn=undefined
        if(packet.result.status==='SUCCESS')turn?.resolve(packet.result)
        else turn?.reject(new Error(packet.result.error || `Antigravity: ${packet.result.status}. Revisá los permisos o la autenticación en su CLI.`))
      }
      return
    }
    if(packet.method && packet.id!==undefined) {
      if(packet.method==='session/request_permission') {
        // Only the user at this terminal can choose a permission. Peers never grant it.
        const result = packet.params?.sessionId===this.sessionId
          ? await this.permission(packet.params) : {outcome:{outcome:'cancelled'}}
        this.write({jsonrpc:'2.0',id:packet.id,result})
      } else this.write({jsonrpc:'2.0',id:packet.id,error:{code:-32601,message:'Método de cliente no soportado'}})
    } else if(packet.id!==undefined) {
      const request=this.pending.get(packet.id);this.pending.delete(packet.id)
      if(packet.error)request?.reject(Object.assign(new Error(packet.error.message ?? 'Error ACP'),{code:packet.error.code}))
      else request?.resolve(packet.result)
    } else if(packet.method==='session/update' || packet.method==='session/notification') {
      if(packet.params?.sessionId!==this.sessionId)return
      const update=packet.params?.update
      if(update?.sessionUpdate==='agent_message_chunk' && update.content?.type==='text')this.output(update.content.text)
      if(update?.sessionUpdate==='tool_call')this.output(`\n[${update.title ?? 'Herramienta'}]\n`)
    }
  }
  /** Initialize only: no conversation, MCP servers or inference are started. */
  async initialize(timeout=10000):Promise<Packet> {
    if(this.initialized)return this.initialized
    if(this.format==='antigravity')throw new Error('No hay consulta de cuotas documentada para este transporte.')
    this.initialized=await this.request('initialize',this.format==='codex'
      ? {clientInfo:{name:'agent-hub',version:'0.10.1'},capabilities:{experimentalApi:false}}
      : {protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'agent-hub',version:'0.10.1'}},timeout)
    if(this.format==='codex')this.write({method:'initialized'})
    return this.initialized!
  }
  async start(cwd:string, mcpServers:Packet[], resume?:string) {
    if(this.format==='codex') {
      await this.initialize()
      const config:Packet={}
      for(const server of mcpServers)config[`mcp_servers.${server.name}`]={command:server.command,args:server.args,env:Object.fromEntries((server.env ?? []).map((v:Packet)=>[v.name,v.value]))}
      // The CLI's configured model, approvals and sandbox remain authoritative.
      const result=await this.request(resume?'thread/resume':'thread/start',{cwd,config,...(resume?{threadId:resume}:{})},60000)
      this.sessionId=result.thread?.id
      if(!this.sessionId || (resume && this.sessionId!==resume))throw new Error('Codex no devolvió la conversación solicitada.')
      return this.sessionId
    }
    if(this.format==='antigravity') {
      let timer:ReturnType<typeof setTimeout>|undefined
      try { return await Promise.race([this.streamReady,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Antigravity no inició el protocolo stream-json.')),30000)})]) }
      finally {clearTimeout(timer)}
    }
    const init=await this.initialize()
    if(resume && !init.agentCapabilities?.loadSession)throw new Error('Esta versión de la CLI no permite retomar sesiones por ACP.')
    // Never pick an auth method or change a model on behalf of the user.
    // Cached CLI credentials apply; authentication-required is actionable at the terminal.
    this.sessionId=resume ?? ''
    const result=await this.request(resume?'session/load':'session/new',{cwd,mcpServers,...(resume?{sessionId:resume}:{})},60000)
    this.sessionId=resume ?? result.sessionId
    if(!this.sessionId)throw new Error('La CLI no devolvió una identidad de sesión.')
    return this.sessionId
  }
  async prompt(text:string) {
    if(this.format==='acp')return this.request('session/prompt',{sessionId:this.sessionId,prompt:[{type:'text',text}]},0)
    if(this.streamTurn)throw new Error('La sesión ya tiene un turno activo.')
    return new Promise((resolve,reject)=>{
      this.streamTurn={resolve,reject}
      if(this.format==='codex') {
        void this.request('turn/start',{threadId:this.sessionId,input:[{type:'text',text}]}).then(result=>{
          if(this.streamTurn)this.turnId=result.turn?.id ?? this.turnId
        }).catch(error=>{this.streamTurn=undefined;reject(error)})
      } else try{this.write({event:'user',message:{content:text}})}catch(error){this.streamTurn=undefined;reject(error)}
    })
  }
  cancel() {
    if(this.dead)return
    if(this.format==='acp')this.write({jsonrpc:'2.0',method:'session/cancel',params:{sessionId:this.sessionId}})
    else if(this.format==='codex') {
      if(this.turnId)void this.request('turn/interrupt',{threadId:this.sessionId,turnId:this.turnId}).catch(error=>this.fail(error))
    }
    else this.child.kill('SIGINT')
  }
  async close() {
    if(this.dead && this.child.exitCode!==null)return
    this.child.stdin.end();this.child.kill('SIGTERM')
    const timer=setTimeout(()=>this.child.kill('SIGKILL'),3000)
    try{await this.closed}finally{clearTimeout(timer)}
  }
}
