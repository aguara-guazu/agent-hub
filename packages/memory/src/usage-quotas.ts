import { z } from 'zod'
import { digestJson } from '@agenthub/shared'
import type { UsageQuotaObservation, UsageQuotaBinding, UsageQuotaSnapshot, UsageQuotaState,
  UsageQuotaFilter, UsageQuotaAvailability, UsageQuotaIngestResult, UsageQuotaTransition } from '@agenthub/shared'
import type { MemoryDatabase, Sql } from './database.js'
import { check, parse } from './contracts.js'

const identifier=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/)
const timestamp=z.iso.datetime({offset:true}).transform(value=>new Date(value).toISOString())
const state=z.enum(['available','low','exhausted','cooldown','unknown'])
const amount=z.number().finite().nonnegative()
export const usageQuotaObservationSchema=z.object({
  cli:identifier,provider:identifier,account_ref:identifier.optional(),pool_id:identifier,
  model_ids:z.array(identifier).max(100).optional(),observed_at:timestamp,expires_at:timestamp,
  source:z.object({kind:z.literal('native'),adapter:identifier,reference:z.string().max(300).optional()}).strict(),
  windows:z.array(z.object({id:identifier,unit:z.enum(['percent','credits','tokens','requests','unknown']),
    used:amount.optional(),limit:amount.optional(),remaining:amount.optional(),resets_at:timestamp.optional(),status:state.optional()}).strict()).max(32),
  complete:z.boolean().optional(),status:state.optional(),reason:z.string().max(300).optional(),
}).strict().superRefine((value,ctx)=>{
  if(Date.parse(value.expires_at)<=Date.parse(value.observed_at) || Date.parse(value.expires_at)-Date.parse(value.observed_at)>86400000)
    ctx.addIssue({code:'custom',message:'La vigencia debe ser positiva y no superar 24 horas'})
  if(new Set(value.windows.map(item=>item.id)).size!==value.windows.length)
    ctx.addIssue({code:'custom',message:'Las ventanas no pueden repetirse'})
  for(const window of value.windows)if(window.limit!==undefined && window.remaining!==undefined && window.remaining>window.limit)
    ctx.addIssue({code:'custom',message:'El saldo no puede superar el límite'})
})
const bindingSchema=z.object({binding_id:identifier,binding_version:z.number().int().positive(),cli:identifier,provider:identifier,account_ref:identifier.optional()}).strict()
const bindSchema=bindingSchema.omit({binding_version:true}).extend({sample_started_at:timestamp})
export type UsageQuotaBindInput=z.input<typeof bindSchema>

/** Most restrictive simultaneous constraint wins. An unknown window prevents a green result. */
function reduce(states:UsageQuotaState[]):UsageQuotaState {
  for(const value of ['exhausted','cooldown','unknown','low','available'] as const)if(states.includes(value))return value
  return 'unknown'
}
function observedState(observation:UsageQuotaObservation,now:string):UsageQuotaState {
  const states=observation.windows.map(window=>{
    if(window.resets_at && window.resets_at<=now)return 'unknown' as const
    if(window.remaining===0 || (window.limit!==undefined && window.used!==undefined && window.used>=window.limit))return 'exhausted' as const
    if(window.status==='exhausted' || window.status==='cooldown' || window.status==='unknown')return window.status
    const limit=window.limit ?? (window.unit==='percent'?100:undefined)
    const remaining=window.remaining ?? (limit!==undefined && window.used!==undefined?Math.max(0,limit-window.used):undefined)
    if(remaining===0)return 'exhausted' as const
    if(remaining!==undefined && limit!==undefined && limit>0)return remaining/limit<=0.1?'low' as const:'available' as const
    return window.status ?? 'unknown'
  })
  if(observation.status)states.push(observation.status)
  if(observation.complete===false)states.push('unknown')
  return reduce(states)
}
interface PoolRow {id:string;provider:string;account_ref:string|null;pool_id:string;scope:'account'|'binding';observation:UsageQuotaObservation;
  last_known:UsageQuotaObservation|null;observed_status:UsageQuotaState;event_state:UsageQuotaState;observed_at:string;digest:string}

export class UsageQuotas {
  constructor(readonly db:MemoryDatabase,private readonly clock:()=>string=()=>new Date().toISOString()){}

  /** Call before collection. Older sampling attempts cannot switch an installation back to an old account. */
  async bind(raw:UsageQuotaBindInput):Promise<UsageQuotaBinding> {
    const input=parse(bindSchema,raw),now=this.clock()
    check(Date.parse(input.sample_started_at)<=Date.parse(now)+120000,'La observación está en el futuro')
    return this.db.transaction(async sql=>{
      const previous=(await sql.query('SELECT * FROM usage_quota_bindings WHERE binding_id=$1',[input.binding_id]))[0]
      const changed=previous && (previous.cli!==input.cli || previous.provider!==input.provider || previous.account_ref!==(input.account_ref ?? null))
      check(!previous || input.sample_started_at>previous.bound_at || (input.sample_started_at===previous.bound_at && !changed),
        'La vinculación de cuenta fue reemplazada por una observación más reciente',409)
      const version=previous?Number(previous.binding_version)+(changed || !previous.active?1:0):1
      if(changed || (previous && !previous.active))await sql.query('DELETE FROM usage_quota_memberships WHERE binding_id=$1',[input.binding_id])
      await sql.query(`INSERT INTO usage_quota_bindings(binding_id,binding_version,cli,provider,account_ref,active,bound_at) VALUES($1,$2,$3,$4,$5,1,$6)
        ON CONFLICT(binding_id) DO UPDATE SET binding_version=excluded.binding_version,cli=excluded.cli,provider=excluded.provider,
        account_ref=excluded.account_ref,active=1,bound_at=excluded.bound_at`,[input.binding_id,version,input.cli,input.provider,input.account_ref ?? null,input.sample_started_at])
      return {binding_id:input.binding_id,binding_version:version,cli:input.cli,provider:input.provider,...(input.account_ref?{account_ref:input.account_ref}:{})}
    })
  }

  async ingest(raw:UsageQuotaObservation,trusted:UsageQuotaBinding):Promise<UsageQuotaIngestResult> {
    const observation=parse(usageQuotaObservationSchema,raw) as UsageQuotaObservation,binding=parse(bindingSchema,trusted),now=this.clock()
    check(observation.cli===binding.cli && observation.provider===binding.provider && observation.account_ref===binding.account_ref,
      'La cuota no coincide con la identidad nativa autenticada',403)
    check(Date.parse(observation.observed_at)<=Date.parse(now)+120000,'La observación está en el futuro')
    const scope=binding.account_ref?'account':'binding',key=digestJson([binding.provider,scope,binding.account_ref ?? binding.binding_id,observation.pool_id])
    const digest=digestJson(observation)
    return this.db.transaction(async sql=>{
      const current=(await sql.query('SELECT * FROM usage_quota_bindings WHERE binding_id=$1',[binding.binding_id]))[0]
      if(!current?.active || current.binding_version!==binding.binding_version || current.cli!==binding.cli || current.provider!==binding.provider || current.account_ref!==(binding.account_ref ?? null))
        return {accepted:false,reason:'stale_binding',transitions:[]}
      if(observation.observed_at<current.bound_at)return {accepted:false,reason:'out_of_order',transitions:[]}
      const previous=(await sql.query<PoolRow>('SELECT * FROM usage_quota_pools WHERE id=$1',[key]))[0]
      if(previous)await sql.query('INSERT INTO usage_quota_memberships(binding_id,pool_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[binding.binding_id,key])
      if(previous && observation.observed_at<previous.observed_at)return {accepted:false,reason:'out_of_order',transitions:[]}
      if(previous && observation.observed_at===previous.observed_at && digest!==previous.digest)return {accepted:false,reason:'conflicting_observation',transitions:[]}
      // A second installation on the same verified account attaches to the existing pool; it never adds capacity.
      if(previous && digest===previous.digest){
        await sql.query('INSERT INTO usage_quota_memberships(binding_id,pool_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[binding.binding_id,key])
        return {accepted:false,reason:'duplicate',snapshot:await this.snapshot(sql,previous,now),transitions:[]}
      }
      const status=observedState(observation,observation.observed_at),lastKnown=status==='unknown'?(previous?.last_known ?? null):observation
      await sql.query(`INSERT INTO usage_quota_pools(id,provider,account_ref,pool_id,scope,observation,last_known,observed_status,observed_at,digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET observation=excluded.observation,
        last_known=excluded.last_known,observed_status=excluded.observed_status,observed_at=excluded.observed_at,digest=excluded.digest`,
        [key,binding.provider,binding.account_ref ?? null,observation.pool_id,scope,JSON.stringify(observation),lastKnown?JSON.stringify(lastKnown):null,status,observation.observed_at,digest])
      await sql.query('INSERT INTO usage_quota_memberships(binding_id,pool_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[binding.binding_id,key])
      const row=(await sql.query<PoolRow>('SELECT * FROM usage_quota_pools WHERE id=$1',[key]))[0]!,snapshot=await this.snapshot(sql,row,now)
      const transitions:UsageQuotaTransition[]=[]
      // Expired/backfilled data is history, never a present-tense recovery notification.
      if(status!=='unknown' && (previous?.event_state ?? 'unknown')!==status && !snapshot.stale && snapshot.status===status){
        const before=previous?.event_state ?? 'unknown',id=digestJson([key,observation.observed_at,before,status])
        await sql.query('INSERT INTO usage_quota_transitions(id,pool_key,before_state,after_state,observed_at) VALUES($1,$2,$3,$4,$5)',[id,key,before,status,observation.observed_at])
        await sql.query('UPDATE usage_quota_pools SET event_state=$2 WHERE id=$1',[key,status])
        transitions.push({id,pool_key:key,before,after:status,observed_at:observation.observed_at,binding_ids:snapshot.binding_ids,clis:snapshot.clis})
      }
      return {accepted:true,snapshot,transitions}
    })
  }

  private async snapshot(sql:Sql,row:PoolRow,now:string):Promise<UsageQuotaSnapshot> {
    const bindings=await sql.query<{binding_id:string;cli:string}>(`SELECT b.binding_id,b.cli FROM usage_quota_bindings b
      JOIN usage_quota_memberships m ON m.binding_id=b.binding_id WHERE m.pool_key=$1 AND b.active=1 ORDER BY b.binding_id`,[row.id])
    const expired=row.observation.expires_at<=now,status=expired?'unknown':observedState(row.observation,now)
    const resetPassed=row.observation.windows.some(window=>!!window.resets_at && window.resets_at<=now)
    return {id:row.id,provider:row.provider,...(row.account_ref?{account_ref:row.account_ref}:{}),pool_id:row.pool_id,scope:row.scope,
      identity_confidence:row.scope==='account'?'verified':'unknown_account',binding_ids:bindings.map(item=>item.binding_id),clis:[...new Set(bindings.map(item=>item.cli))],
      model_ids:row.observation.model_ids ?? [],status,observed_status:row.observed_status,stale:expired || resetPassed,
      ...(expired?{reason:'expired_observation'}:resetPassed?{reason:'reset_requires_observation'}:row.observation.reason?{reason:row.observation.reason}:{}),
      observation:row.observation,last_known:row.last_known}
  }

  async list(filter:UsageQuotaFilter={}):Promise<UsageQuotaSnapshot[]> {
    const now=filter.now?parse(timestamp,filter.now):this.clock()
    return this.db.transaction(async sql=>{
      const rows=await sql.query<PoolRow>('SELECT * FROM usage_quota_pools ORDER BY provider,pool_id,id'),results=[]
      for(const row of rows){
        if(filter.provider && row.provider!==filter.provider || filter.account_ref && row.account_ref!==filter.account_ref)continue
        const value=await this.snapshot(sql,row,now)
        if(!value.binding_ids.length || filter.binding_id && !value.binding_ids.includes(filter.binding_id) || filter.cli && !value.clis.includes(filter.cli))continue
        if(filter.model && value.model_ids.length && !value.model_ids.includes(filter.model))continue
        results.push(value)
      }
      return results
    },'read')
  }

  async forCli(cli:string,model?:string,filter:Omit<UsageQuotaFilter,'cli'|'model'>={}):Promise<UsageQuotaAvailability> {
    const pools=await this.list({...filter,cli,...(model?{model}:{})})
    if(!pools.length)return {status:'unknown',reason:'no_observation',pools}
    const scopes=new Set(pools.map(pool=>pool.scope==='account'?`${pool.provider}:${pool.account_ref}`:`binding:${pool.binding_ids.join(',')}`))
    if(scopes.size>1)return {status:'unknown',reason:'ambiguous_account',pools}
    return {status:reduce(pools.map(pool=>pool.status)),pools}
  }
}
