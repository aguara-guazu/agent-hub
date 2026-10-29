import { z } from 'zod'
import { digestJson } from '@agenthub/shared'
import type { UsageQuotaObservation, UsageQuotaBinding, UsageQuotaSnapshot, UsageQuotaState, UsageQuotaModelScope, UsageQuotaWindow, UsageQuotaWindowEvidence, UsageQuotaStatusEvidence,
  UsageQuotaFilter, UsageQuotaAvailability, UsageQuotaIngestResult, UsageQuotaTransition } from '@agenthub/shared'
import type { MemoryDatabase, Sql } from './database.js'
import { check, parse } from './contracts.js'

const identifier=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/)
const timestamp=z.iso.datetime({offset:true}).transform(value=>new Date(value).toISOString())
const state=z.enum(['available','low','exhausted','cooldown','unknown'])
const amount=z.number().finite().nonnegative()
export const usageQuotaObservationSchema=z.object({
  cli:identifier,provider:identifier,account_ref:identifier.optional(),pool_id:identifier,
  model_scope:z.enum(['all','listed','unknown']).optional(),model_ids:z.array(identifier).max(100).optional(),observed_at:timestamp,expires_at:timestamp,
  source:z.object({kind:z.literal('native'),adapter:identifier,reference:z.string().max(300).optional()}).strict(),
  windows:z.array(z.object({id:identifier,unit:z.enum(['percent','credits','tokens','requests','unknown']),
    used:amount.optional(),limit:amount.optional(),remaining:amount.optional(),resets_at:timestamp.optional(),duration_minutes:z.number().finite().positive().optional(),status:state.optional()}).strict()).max(32),
  complete:z.boolean().optional(),status:state.optional(),reason:z.string().max(300).optional(),
}).strict().superRefine((value,ctx)=>{
  if(value.model_scope==='listed' && !value.model_ids?.length)ctx.addIssue({code:'custom',message:'El alcance por modelo requiere identificadores nativos'})
  if((value.model_scope==='all' || value.model_scope==='unknown') && value.model_ids?.length)ctx.addIssue({code:'custom',message:'Los modelos listados requieren alcance listed'})
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

function modelScope(observation:UsageQuotaObservation):UsageQuotaModelScope {
  return observation.model_scope ?? (observation.model_ids?.length?'listed':'all')
}

/** Most restrictive simultaneous constraint wins. An unknown window prevents a green result. */
function reduce(states:UsageQuotaState[]):UsageQuotaState {
  for(const value of ['exhausted','cooldown','unknown','low','available'] as const)if(states.includes(value))return value
  return 'unknown'
}
function windowState(window:UsageQuotaWindow,now:string):UsageQuotaState {
  if(window.resets_at && window.resets_at<=now)return 'unknown'
  const limit=window.limit ?? (window.unit==='percent'?100:undefined)
  const remaining=window.remaining ?? (limit!==undefined && window.used!==undefined?Math.max(0,limit-window.used):undefined)
  const numerical:UsageQuotaState=remaining===0 || (limit!==undefined && window.used!==undefined && window.used>=limit)?'exhausted'
    : remaining!==undefined && limit!==undefined && limit>0 ? (remaining/limit<=0.1?'low':'available') : 'unknown'
  // An explicit native warning can be stricter than the generic 10% threshold.
  return window.status?reduce([window.status,...(numerical==='unknown'?[]:[numerical])]):numerical
}
function observedState(observation:UsageQuotaObservation,now:string):UsageQuotaState {
  const states=observation.windows.map(window=>windowState(window,now))
  if(observation.status)states.push(observation.status)
  if(observation.complete===false)states.push('unknown')
  return reduce(states)
}
type WindowEvidence=Record<string,UsageQuotaWindowEvidence>
function evidenceFor(observation:UsageQuotaObservation,previous:WindowEvidence={}):WindowEvidence {
  const evidence={...previous}
  for(const window of observation.windows){
    const old=evidence[window.id]
    // Unknown is not evidence that a previously confirmed constraint has recovered.
    if(old && old.expires_at>observation.observed_at && windowState(old.window,observation.observed_at)!=='unknown'
      && windowState(window,observation.observed_at)==='unknown')continue
    evidence[window.id]={window,observed_at:observation.observed_at,expires_at:observation.expires_at,source:observation.source}
  }
  check(Object.keys(evidence).length<=128,'El pool supera el máximo de ventanas conocidas')
  return evidence
}
function statusEvidenceFor(observation:UsageQuotaObservation,previous:UsageQuotaStatusEvidence|null=null):UsageQuotaStatusEvidence|null {
  // Aggregate warnings have their own validity. Window-derived constraints keep their individual reset times instead.
  if(observation.status && observation.status!=='unknown')return {status:observation.status,observed_at:observation.observed_at,
    expires_at:observation.expires_at,source:observation.source}
  if(observation.complete===true && observation.windows.length && observedState(observation,observation.observed_at)!=='unknown')return null
  return previous
}
function effectiveState(observation:UsageQuotaObservation,evidence:WindowEvidence,aggregate:UsageQuotaStatusEvidence|null,now:string):UsageQuotaState {
  return reduce([observation.expires_at<=now?'unknown':observedState(observation,now),...Object.values(evidence).map(item=>
    item.expires_at<=now?'unknown' as const:windowState(item.window,now)),...(aggregate?[aggregate.expires_at<=now?'unknown' as const:aggregate.status]:[])])
}
interface PoolRow {active:boolean;id:string;provider:string;account_ref:string|null;pool_id:string;scope:'account'|'binding';observation:UsageQuotaObservation;window_evidence:WindowEvidence;status_evidence:UsageQuotaStatusEvidence|null;
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
      if(previous && (observation.observed_at<previous.observed_at || !previous.active && observation.observed_at===previous.observed_at))return {accepted:false,reason:'out_of_order',transitions:[]}
      if(previous && observation.observed_at===previous.observed_at && digest!==previous.digest)return {accepted:false,reason:'conflicting_observation',transitions:[]}
      // A second installation on the same verified account attaches to the existing pool; it never adds capacity.
      if(previous && digest===previous.digest){
        await sql.query('INSERT INTO usage_quota_memberships(binding_id,pool_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[binding.binding_id,key])
        return {accepted:false,reason:'duplicate',snapshot:await this.snapshot(sql,previous,now),transitions:[]}
      }
      const evidence=evidenceFor(observation,previous?.window_evidence),aggregate=statusEvidenceFor(observation,previous?.status_evidence),
        status=effectiveState(observation,evidence,aggregate,observation.observed_at),
        lastKnown=observedState(observation,observation.observed_at)==='unknown'?(previous?.last_known ?? null):observation
      await sql.query(`INSERT INTO usage_quota_pools(id,provider,account_ref,pool_id,scope,observation,last_known,observed_status,observed_at,digest,window_evidence,status_evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO UPDATE SET active=1,observation=excluded.observation,
        status_evidence=excluded.status_evidence,window_evidence=excluded.window_evidence,last_known=excluded.last_known,observed_status=excluded.observed_status,observed_at=excluded.observed_at,digest=excluded.digest`,
        [key,binding.provider,binding.account_ref ?? null,observation.pool_id,scope,JSON.stringify(observation),lastKnown?JSON.stringify(lastKnown):null,status,observation.observed_at,digest,JSON.stringify(evidence),aggregate?JSON.stringify(aggregate):null])
      await sql.query('INSERT INTO usage_quota_memberships(binding_id,pool_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[binding.binding_id,key])
      const row=(await sql.query<PoolRow>('SELECT * FROM usage_quota_pools WHERE id=$1',[key]))[0]!,snapshot=await this.snapshot(sql,row,now)
      const transitions:UsageQuotaTransition[]=[]
      // Expired/backfilled data is history, never a present-tense recovery notification.
      if(status!=='unknown' && (previous?.event_state ?? 'unknown')!==status && observation.expires_at>now && (!snapshot.stale || status==='exhausted' || status==='cooldown') && snapshot.status===status){
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
      WHERE b.active=1 AND (($2='account' AND b.provider=$3 AND b.account_ref=$4)
        OR ($2='binding' AND EXISTS(SELECT 1 FROM usage_quota_memberships m WHERE m.binding_id=b.binding_id AND m.pool_key=$1)))
      ORDER BY b.binding_id`,[row.id,row.scope,row.provider,row.account_ref])
    const evidence=row.window_evidence ?? evidenceFor(row.observation),values=Object.values(evidence)
    const aggregate=row.status_evidence ?? null
    const expired=row.observation.expires_at<=now || values.some(item=>item.expires_at<=now) || !!aggregate && aggregate.expires_at<=now,
      status=effectiveState(row.observation,evidence,aggregate,now)
    const resetPassed=values.some(item=>!!item.window.resets_at && item.window.resets_at<=now)
    return {id:row.id,provider:row.provider,...(row.account_ref?{account_ref:row.account_ref}:{}),pool_id:row.pool_id,scope:row.scope,
      identity_confidence:row.scope==='account'?'verified':'unknown_account',binding_ids:bindings.map(item=>item.binding_id),clis:[...new Set(bindings.map(item=>item.cli))],
      model_scope:modelScope(row.observation),model_ids:row.observation.model_ids ?? [],status,observed_status:row.observed_status,stale:expired || resetPassed,
      ...(expired?{reason:'expired_observation'}:resetPassed?{reason:'reset_requires_observation'}:row.observation.reason?{reason:row.observation.reason}:{}),
      observation:row.observation,last_known:row.last_known,retained_windows:values.filter(item=>item.observed_at!==row.observation.observed_at),
      ...(aggregate && aggregate.observed_at!==row.observation.observed_at?{retained_status:aggregate}:{})}
  }

  private matchingBindings(sql:Sql,filter:UsageQuotaFilter) {
    return sql.query<{binding_id:string;provider:string;account_ref:string|null}>(`SELECT binding_id,provider,account_ref
      FROM usage_quota_bindings WHERE active=1 AND ($1 IS NULL OR cli=$1) AND ($2 IS NULL OR provider=$2)
        AND ($3 IS NULL OR binding_id=$3) AND ($4 IS NULL OR account_ref=$4)`,
      [filter.cli ?? null,filter.provider ?? null,filter.binding_id ?? null,filter.account_ref ?? null])
  }

  async list(filter:UsageQuotaFilter={}):Promise<UsageQuotaSnapshot[]> {
    const now=filter.now?parse(timestamp,filter.now):this.clock()
    return this.db.transaction(async sql=>{
      const matching=new Set((await this.matchingBindings(sql,filter)).map(binding=>binding.binding_id))
      const rows=await sql.query<PoolRow>('SELECT * FROM usage_quota_pools WHERE active=1 ORDER BY provider,pool_id,id'),results=[]
      for(const row of rows){
        if(filter.provider && row.provider!==filter.provider || filter.account_ref && row.account_ref!==filter.account_ref)continue
        const value=await this.snapshot(sql,row,now)
        if(!value.binding_ids.some(bindingId=>matching.has(bindingId)))continue
        if(filter.model && value.model_scope==='listed' && !value.model_ids.includes(filter.model))continue
        results.push(value)
      }
      return results
    },'read')
  }

  async forCli(cli:string,model?:string,filter:Omit<UsageQuotaFilter,'cli'|'model'>={}):Promise<UsageQuotaAvailability> {
    return this.db.transaction(async sql=>{
      // Resolve the requested CLI/profile/account scope before looking at observations. A newly bound profile
      // without a sample must not silently inherit the availability of a different, already observed account.
      const bindings=await this.matchingBindings(sql,{...filter,cli})
      if(!bindings.length)return {status:'unknown',reason:'no_observation',pools:[]}
      const scopes=new Set(bindings.map(binding=>digestJson(binding.account_ref
        ? ['account',binding.provider,binding.account_ref]:['binding',binding.provider,binding.binding_id])))
      const pools=await this.list({...filter,cli,...(model?{model}:{})})
      if(scopes.size>1)return {status:'unknown',reason:'ambiguous_account',pools}
      if(!pools.length)return {status:'unknown',reason:'no_observation',pools}
      // Observed exhaustion of an unidentified model pool is not evidence that the requested model is exhausted.
      const status=reduce(pools.map(pool=>pool.model_scope==='unknown'?'unknown':pool.status))
      return {status,...(status==='unknown' && pools.some(pool=>pool.model_scope==='unknown')?{reason:'unknown_model_scope'}:{}),pools}
    },'read')
  }

  /**
   * Pool that was exhausted or cooling down at an instant, from the persisted transitions and not from today's state.
   * Observations can arrive after the failure they explain, so the last transition up to windowMs after `at` counts.
   * Ambiguous accounts and pools of unknown model scope are never evidence.
   */
  async exhaustedAt(cli:string,model:string,at:string,windowMs=120_000):Promise<{pool_key:string}|undefined> {
    const limit=new Date(Date.parse(parse(timestamp,at))+windowMs).toISOString()
    const current=await this.forCli(cli,model)
    if(current.reason==='ambiguous_account')return undefined
    for(const pool of current.pools){
      if(pool.model_scope==='unknown')continue
      const last=(await this.db.query<{after_state:string}>('SELECT after_state FROM usage_quota_transitions WHERE pool_key=$1 AND observed_at<=$2 ORDER BY observed_at DESC LIMIT 1',[pool.id,limit]))[0]
      if(last && (last.after_state==='exhausted' || last.after_state==='cooldown'))return {pool_key:pool.id}
    }
    return undefined
  }
}
