import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { nativeSession } from '@agenthub/gateway'
import { check, parse } from './contracts.js'
import type { MemoryService } from './service.js'
import type { MemoryRouteOptions } from './routes.js'
import { usageQuotaObservationSchema } from './usage-quotas.js'
import type { UsageQuotaBinding, UsageQuotaObservation } from '@agenthub/shared'

const installedIdentity={agent_id:z.string().min(1).max(200)}
const identity={agent_id:z.string().min(1).max(200),native_id:z.string().min(1).max(300),session_key:z.string().min(32).max(200)}
const account=z.string().regex(/^[a-f0-9]{64}$/).optional()
const binding=z.object({binding_id:z.string().min(1).max(200),binding_version:z.number().int().positive(),cli:z.string().max(60),provider:z.string().max(60),account_ref:account}).strict()
const schema=(session:boolean)=>z.discriminatedUnion('action',[
  z.object({...(session?identity:installedIdentity),action:z.literal('bind'),provider:z.string().max(60),account_ref:account,profile_ref:account,sample_started_at:z.iso.datetime()}).strict(),
  z.object({...(session?identity:installedIdentity),action:z.literal('observe'),binding,observation:usageQuotaObservationSchema}).strict(),
])
const adapters:Record<string,{provider:string;source:string[]}>={codex_cli:{provider:'openai',source:['codex-app-server']},claude_code:{provider:'anthropic',source:['claude-statusline','claude-control']},kiro:{provider:'kiro',source:['kiro-acp']},gemini_cli:{provider:'google',source:['gemini-quota']},opencode:{provider:'opencode',source:['opencode-go']},antigravity:{provider:'google-antigravity',source:['antigravity-statusline']}}

/** Daemon-only ingress. The model can inspect quota but cannot manufacture observations through MCP. */
export function registerUsageRoutes(app:FastifyInstance,service:MemoryService,options:MemoryRouteOptions) {
  if(!options.authorizeChatAgent)return
  for(const session of [true,false])app.post('/api/memory/usage/'+(session?'native':'installed'),{bodyLimit:32768},async(request,reply)=>{
    const input=parse(schema(session),request.body) as any
    const authorize=session?options.authorizeChatAgent:options.authorizeUsageAgent
    check(authorize,'La consulta de cuotas del cliente no está disponible',403)
    const client=await authorize(request,input.agent_id)
    check(!options.usageAgentEnabled || options.usageAgentEnabled(input.agent_id),'La consulta de cuotas está deshabilitada para este cliente',403)
    const expected=adapters[client.cli_kind]
    check(expected,'Esta CLI no tiene un adaptador nativo de cuotas',400)
    const {operations,db}=await service.get()
    if(session){
      const who=await operations.chat.identity(nativeSession(input.agent_id,client.cli_kind,input.native_id,null),input.session_key)
      check(!who.closed_at && who.native_id===input.native_id && who.cli_kind===client.cli_kind,'La observación no pertenece a esta sesión activa',403)
    }
    reply.header('Cache-Control','no-store')
    if(input.action==='bind') {
      check(input.provider===expected.provider,'Proveedor incompatible con la CLI autenticada',400)
      check(Date.parse(input.sample_started_at)<=Date.now()+5000,'Fecha de observación futura',400)
      return {binding:await operations.usage.bind({binding_id:input.profile_ref?`${input.agent_id}:profile:${input.profile_ref}`:input.agent_id,cli:client.cli_kind,provider:expected.provider,
        ...(input.account_ref?{account_ref:input.account_ref}:{}),sample_started_at:input.sample_started_at})}
    }
    const bindingId=input.binding.binding_id,profileSuffix=bindingId.startsWith(`${input.agent_id}:profile:`)?bindingId.slice(input.agent_id.length+9):''
    check((bindingId===input.agent_id || /^[a-f0-9]{64}$/.test(profileSuffix)) && input.binding.cli===client.cli_kind && input.binding.provider===expected.provider,
      'El ticket no pertenece al cliente autenticado',403)
    check(input.observation.cli===client.cli_kind && input.observation.provider===expected.provider && expected.source.includes(input.observation.source.adapter),
      'Fuente incompatible con la CLI autenticada',400)
    // Persist the observation and its recipients atomically: a crash must not lose a transition's notice.
    const result=await db.transaction(async()=>{
      const value=await operations.usage.ingest(input.observation as UsageQuotaObservation,input.binding as UsageQuotaBinding)
      if(value.snapshot && value.snapshot.model_scope!=='unknown')for(const transition of value.transitions)for(const cli of transition.clis)await operations.usageNotices.publish({
        key:transition.id,cli,provider:value.snapshot.provider,pool_id:value.snapshot.pool_id,state:transition.after,previous_state:transition.before,
        observed_at:transition.observed_at,binding_ids:transition.binding_ids,model_ids:value.snapshot.model_ids,
        ...(value.snapshot.account_ref?{account_ref:value.snapshot.account_ref}:{})},false)
      return value
    })
    if(result.transitions.length)operations.chat.events.emit('change')
    return result
  })
}
