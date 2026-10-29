import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {UsageQuotaObservation} from '@agenthub/shared'
import {MemoryDatabase} from '../src/database.js'
import {MemoryStore} from '../src/store.js'
import {exportMemory,readBackup,restoreMemory} from '../src/backup.js'
import {UsageQuotas} from '../src/usage-quotas.js'

let dir:string,db:MemoryDatabase,quotas:UsageQuotas,now:string
const start='2026-10-20T10:00:00.000Z'
const future='2026-10-20T10:15:00.000Z'
const observation=(extra:Partial<UsageQuotaObservation>={}):UsageQuotaObservation=>({cli:'codex_cli',provider:'openai',account_ref:'opaque-account',pool_id:'codex',
  observed_at:start,expires_at:future,source:{kind:'native',adapter:'app-server'},complete:true,
  windows:[{id:'five_hour',unit:'percent',used:20,limit:100,resets_at:'2026-10-20T14:00:00.000Z'},
    {id:'weekly',unit:'percent',used:30,limit:100,resets_at:'2026-10-23T10:00:00.000Z'}],...extra})
const bind=(binding_id='installed-codex',account_ref:string|undefined='opaque-account',sample_started_at=start)=>quotas.bind({binding_id,cli:'codex_cli',provider:'openai',...(account_ref?{account_ref}:{}),sample_started_at})
beforeEach(async()=>{now=start;dir=await mkdtemp(join(tmpdir(),'hub-quota-'));db=new MemoryDatabase(join(dir,'memory.sqlite'));await db.migrate();quotas=new UsageQuotas(db,()=>now)})
afterEach(async()=>{await db.close();await rm(dir,{recursive:true,force:true})})

it('reduces concurrent windows without summing or concealing a weekly exhaustion',async()=>{
  const ticket=await bind(),input=observation({windows:[{id:'five_hour',unit:'percent',used:5,limit:100},{id:'weekly',unit:'percent',used:100,limit:100}]})
  const result=await quotas.ingest(input,ticket)
  expect(result.snapshot).toMatchObject({status:'exhausted',scope:'account',identity_confidence:'verified'})
  expect(result.transitions).toMatchObject([{before:'unknown',after:'exhausted'}])
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'exhausted'})
  now='2026-10-20T10:01:00.000Z'
  expect((await quotas.ingest(observation({observed_at:now,windows:[{id:'five_hour',unit:'percent',used:91,limit:100},{id:'weekly',unit:'percent',used:20,limit:100}]}),ticket)).snapshot?.status).toBe('low')
})

it('deduplicates simultaneous collection and keeps one pool across verified installations',async()=>{
  const a=await bind(),b=await bind('second-installation')
  const results=await Promise.all([quotas.ingest(observation(),a),quotas.ingest(observation(),b),quotas.ingest(observation(),a)])
  expect(results.filter(result=>result.accepted)).toHaveLength(1)
  expect(results.flatMap(result=>result.transitions)).toHaveLength(1)
  const pools=await quotas.list();expect(pools).toHaveLength(1)
  expect(pools[0]?.binding_ids).toEqual(['installed-codex','second-installation'])
  expect((await db.query('SELECT count(*) AS n FROM usage_quota_transitions'))[0]?.n).toBe(1)
})

it('rejects late observations and conflicting same-timestamp rewrites',async()=>{
  const ticket=await bind();now='2026-10-20T10:02:00.000Z'
  await quotas.ingest(observation({observed_at:now,status:'exhausted'}),ticket)
  expect(await quotas.ingest(observation(),ticket)).toMatchObject({accepted:false,reason:'out_of_order',transitions:[]})
  expect(await quotas.ingest(observation({observed_at:now}),ticket)).toMatchObject({accepted:false,reason:'conflicting_observation'})
  expect((await quotas.list())[0]?.status).toBe('exhausted')
})

it('rejects a delayed account switch and invalidates in-flight observations from an old binding',async()=>{
  const old=await bind();await quotas.ingest(observation(),old)
  now='2026-10-20T10:02:00.000Z'
  const current=await bind('installed-codex','new-account',now)
  await expect(bind()).rejects.toMatchObject({statusCode:409})
  await expect(bind('installed-codex','opaque-account',now)).rejects.toMatchObject({statusCode:409})
  expect(await quotas.ingest(observation({observed_at:now}),old)).toMatchObject({accepted:false,reason:'stale_binding'})
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'unknown',reason:'no_observation'})
  await quotas.ingest(observation({account_ref:'new-account',observed_at:now,status:'exhausted'}),current)
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'exhausted'})
  await expect(quotas.ingest(observation({observed_at:now}),current)).rejects.toMatchObject({statusCode:403})
})

it('never treats elapsed reset or freshness as native recovery and retains last known values',async()=>{
  const ticket=await bind();await quotas.ingest(observation({windows:[{id:'five_hour',unit:'percent',used:100,limit:100,resets_at:'2026-10-20T10:05:00.000Z'}]}),ticket)
  now='2026-10-20T10:06:00.000Z'
  expect((await quotas.list())[0]).toMatchObject({status:'unknown',stale:true,reason:'reset_requires_observation',observed_status:'exhausted',last_known:{windows:[{used:100}]}})
  expect((await db.query('SELECT count(*) AS n FROM usage_quota_transitions'))[0]?.n).toBe(1)
  now='2026-10-20T10:16:00.000Z'
  expect((await quotas.list())[0]).toMatchObject({status:'unknown',stale:true,reason:'expired_observation'})
  const restored=await quotas.ingest(observation({observed_at:now,expires_at:'2026-10-20T10:30:00.000Z'}),ticket)
  expect(restored.transitions).toMatchObject([{before:'exhausted',after:'available'}])
})

it('records missing/unknown response without relabeling historical values as current',async()=>{
  const ticket=await bind();await quotas.ingest(observation(),ticket)
  now='2026-10-20T10:01:00.000Z'
  const result=await quotas.ingest(observation({observed_at:now,windows:[],status:'unknown',reason:'not_reported'}),ticket)
  expect(result.snapshot).toMatchObject({status:'unknown',reason:'not_reported',last_known:{observed_at:start,windows:[{id:'five_hour'},{id:'weekly'}]}})
  now='2026-10-20T10:02:00.000Z'
  expect((await quotas.ingest(observation({observed_at:now,complete:false}),ticket)).snapshot?.status).toBe('unknown')
})

it('keeps unknown identity scoped to installation and rejects ambiguous account planning',async()=>{
  const first=await bind('first','account-one'),second=await bind('second','account-two')
  await quotas.ingest(observation({account_ref:'account-one',status:'exhausted'}),first)
  await quotas.ingest(observation({account_ref:'account-two'}),second)
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'unknown',reason:'ambiguous_account'})
  expect(await quotas.forCli('codex_cli',undefined,{binding_id:'second'})).toMatchObject({status:'available'})
  const unknown=await quotas.bind({binding_id:'unknown-profile',cli:'codex_cli',provider:'openai',sample_started_at:start})
  const {account_ref:_,...input}=observation()
  expect((await quotas.ingest(input,unknown)).snapshot).toMatchObject({scope:'binding',identity_confidence:'unknown_account'})
})

it('keeps model-specific pools separate without filtering global account constraints',async()=>{
  const ticket=await bind()
  await quotas.ingest(observation({pool_id:'global'}),ticket)
  await quotas.ingest(observation({pool_id:'specific',model_ids:['large-model'],status:'exhausted'}),ticket)
  expect(await quotas.forCli('codex_cli','large-model')).toMatchObject({status:'exhausted'})
  expect(await quotas.forCli('codex_cli','small-model')).toMatchObject({status:'available'})
})

it('rejects invalid amounts, dates, identities and unsupported raw fields',async()=>{
  const ticket=await bind()
  await expect(quotas.ingest(observation({windows:[{id:'x',unit:'credits',remaining:-1}]}),ticket)).rejects.toBeTruthy()
  await expect(quotas.ingest(observation({windows:[{id:'x',unit:'credits',remaining:12,limit:10}]}),ticket)).rejects.toBeTruthy()
  await expect(quotas.ingest(observation({expires_at:start}),ticket)).rejects.toBeTruthy()
  await expect(quotas.ingest(observation({observed_at:'2026-10-21T10:00:00.000Z',expires_at:'2026-10-21T11:00:00.000Z'}),ticket)).rejects.toBeTruthy()
  await expect(quotas.ingest({...observation(),token:'secret'} as UsageQuotaObservation,ticket)).rejects.toBeTruthy()
  expect(await quotas.list()).toEqual([])
})

it('restores historical quota observations with inactive bindings and invalid native tickets',async()=>{
  const ticket=await bind();await quotas.ingest(observation(),ticket)
  const store=new MemoryStore(db,dir),backup=JSON.parse(await readBackup(store,(await exportMemory(store)).id))
  expect(backup.schema_version).toBe(23)
  const restoredDir=await mkdtemp(join(tmpdir(),'hub-quota-restore-')),restoredDb=new MemoryDatabase(join(restoredDir,'memory.sqlite'))
  try{
    await restoredDb.migrate();await restoreMemory(new MemoryStore(restoredDb,restoredDir),backup)
    const restored=new UsageQuotas(restoredDb,()=>now)
    expect(await restored.list()).toEqual([])
    expect(await restored.ingest(observation(),ticket)).toMatchObject({accepted:false,reason:'stale_binding'})
    expect((await restoredDb.query('SELECT count(*) AS n FROM usage_quota_pools'))[0]?.n).toBe(1)
    const rebound=await restored.bind({binding_id:ticket.binding_id,cli:ticket.cli,provider:ticket.provider,account_ref:ticket.account_ref!,sample_started_at:now})
    expect(rebound.binding_version).toBeGreaterThan(ticket.binding_version)
    expect(await restored.list()).toEqual([])
  }finally{await restoredDb.close();await rm(restoredDir,{recursive:true,force:true})}
})

it('requires explicit native recovery after reset while another window can still block',async()=>{
  const ticket=await bind()
  await quotas.ingest(observation({windows:[{id:'five_hour',unit:'percent',used:100,resets_at:'2026-10-20T10:05:00.000Z'},
    {id:'weekly',unit:'percent',used:100,resets_at:'2026-10-23T10:00:00.000Z'}]}),ticket)
  now='2026-10-20T10:06:00.000Z'
  expect((await quotas.list())[0]).toMatchObject({status:'exhausted',stale:true})
  expect((await db.query('SELECT count(*) AS n FROM usage_quota_transitions'))[0]?.n).toBe(1)
})

it('attaches a second CLI to the same account pool even when concurrent snapshots conflict',async()=>{
  const first=await bind(),second=await quotas.bind({binding_id:'other-client',cli:'another_cli',provider:'openai',account_ref:'opaque-account',sample_started_at:start})
  await quotas.ingest(observation({status:'exhausted'}),first)
  expect(await quotas.ingest(observation({cli:'another_cli'}),second)).toMatchObject({accepted:false,reason:'conflicting_observation'})
  expect(await quotas.forCli('another_cli')).toMatchObject({status:'exhausted'})
  expect(await quotas.list()).toHaveLength(1)
})

it('never notifies recovery for an already expired backfill',async()=>{
  const ticket=await bind();await quotas.ingest(observation({status:'exhausted'}),ticket)
  now='2026-10-20T11:00:00.000Z'
  const result=await quotas.ingest(observation({observed_at:'2026-10-20T10:01:00.000Z'}),ticket)
  expect(result).toMatchObject({accepted:true,transitions:[],snapshot:{status:'unknown',stale:true}})
  const fresh=await quotas.ingest(observation({observed_at:now,expires_at:'2026-10-20T11:15:00.000Z'}),ticket)
  expect(fresh.transitions).toMatchObject([{before:'exhausted',after:'available'}])
})

it('retains cooldown as a reported quota constraint and makes absent CLI data unknown',async()=>{
  const ticket=await bind()
  await quotas.ingest(observation({windows:[],status:'cooldown'}),ticket)
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'cooldown'})
  expect(await quotas.forCli('kiro')).toMatchObject({status:'unknown',reason:'no_observation'})
})

it('preserves omitted weekly exhaustion through partial updates with original freshness and provenance',async()=>{
  const ticket=await bind()
  await quotas.ingest(observation({windows:[{id:'five_hour',unit:'percent',used:10},{id:'weekly',unit:'percent',used:100,
    resets_at:'2026-10-20T10:10:00.000Z'}]}),ticket)
  now='2026-10-20T10:05:00.000Z'
  const partial=await quotas.ingest(observation({observed_at:now,expires_at:'2026-10-20T10:30:00.000Z',complete:false,
    windows:[{id:'five_hour',unit:'percent',used:20}]}),ticket)
  expect(partial).toMatchObject({snapshot:{status:'exhausted',retained_windows:[{window:{id:'weekly',used:100},observed_at:start,expires_at:future}]},transitions:[]})
  now='2026-10-20T10:11:00.000Z'
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'unknown'})
  expect((await db.query('SELECT count(*) AS n FROM usage_quota_transitions'))[0]?.n).toBe(1)
  now='2026-10-20T10:12:00.000Z'
  const recovered=await quotas.ingest(observation({observed_at:now,windows:[{id:'five_hour',unit:'percent',used:10},{id:'weekly',unit:'percent',used:5}]}),ticket)
  expect(recovered).toMatchObject({snapshot:{status:'available'},transitions:[{before:'exhausted',after:'available'}]})
})

it('does not extend a retained restriction expiry with partial updates or replace it with unknown',async()=>{
  const ticket=await bind()
  await quotas.ingest(observation({windows:[{id:'weekly',unit:'credits',remaining:0,limit:100}]}),ticket)
  now='2026-10-20T10:05:00.000Z'
  await quotas.ingest(observation({observed_at:now,expires_at:'2026-10-20T10:30:00.000Z',complete:false,
    windows:[{id:'weekly',unit:'unknown',status:'unknown'}]}),ticket)
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'exhausted'})
  now='2026-10-20T10:16:00.000Z'
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'unknown'})
  expect((await quotas.list())[0]?.retained_windows?.[0]?.expires_at).toBe(future)
})

it('propagates account-wide constraints to verified bindings without explicit pool membership',async()=>{
  const a=await bind(),b=await bind('second-installation')
  await quotas.ingest(observation({pool_id:'global',status:'exhausted'}),a)
  await quotas.ingest(observation({pool_id:'small-pool',model_ids:['small-model']}),b)
  const result=await quotas.forCli('codex_cli','small-model',{binding_id:b.binding_id})
  expect(result.status).toBe('exhausted');expect(result.pools).toHaveLength(2)
  expect(result.pools.find(pool=>pool.pool_id==='global')?.binding_ids).toEqual(['installed-codex','second-installation'])
})

it('shares model-scoped account pools only for matching models and isolates other identities',async()=>{
  const a=await bind(),b=await bind('second-installation'),other=await bind('other-account','other-account')
  await quotas.ingest(observation({pool_id:'large-pool',model_ids:['large-model'],status:'exhausted'}),a)
  await quotas.ingest(observation({pool_id:'small-pool',model_ids:['small-model']}),b)
  await quotas.ingest(observation({account_ref:'other-account',pool_id:'large-pool',model_ids:['large-model']}),other)
  expect(await quotas.forCli('codex_cli','small-model',{binding_id:b.binding_id})).toMatchObject({status:'available'})
  expect(await quotas.forCli('codex_cli','large-model',{binding_id:b.binding_id})).toMatchObject({status:'exhausted'})
  expect(await quotas.forCli('codex_cli','large-model',{binding_id:other.binding_id})).toMatchObject({status:'available'})
})

it('retains native low warnings even when the generic percentage threshold is less restrictive',async()=>{
  const ticket=await bind()
  expect((await quotas.ingest(observation({windows:[{id:'native',unit:'percent',used:20,limit:100,status:'low',duration_minutes:300}]}),ticket)).snapshot)
    .toMatchObject({status:'low',observation:{windows:[{duration_minutes:300}]}})
  now='2026-10-20T10:01:00.000Z'
  expect((await quotas.ingest(observation({observed_at:now,windows:[{id:'native',unit:'percent',used:100,limit:100,status:'available'}]}),ticket)).snapshot?.status).toBe('exhausted')
  await expect(quotas.ingest(observation({observed_at:now,windows:[{id:'native',unit:'percent',duration_minutes:0}]}),ticket)).rejects.toBeTruthy()
})

it.each(['cooldown','exhausted'] as const)('retains native aggregate %s through partial unknown without extending its TTL',async status=>{
  const ticket=await bind()
  await quotas.ingest(observation({windows:[],status}),ticket)
  now='2026-10-20T10:02:00.000Z'
  const partial=await quotas.ingest(observation({observed_at:now,expires_at:'2026-10-20T10:30:00.000Z',windows:[],status:'unknown',complete:false}),ticket)
  expect(partial).toMatchObject({transitions:[],snapshot:{status,retained_status:{status,observed_at:start,expires_at:future,source:{kind:'native',adapter:'app-server'}}}})
  now='2026-10-20T10:16:00.000Z'
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'unknown'})
  expect((await db.query('SELECT count(*) AS n FROM usage_quota_transitions'))[0]?.n).toBe(1)
  now='2026-10-20T10:17:00.000Z'
  const recovered=await quotas.ingest(observation({observed_at:now,expires_at:'2026-10-20T10:30:00.000Z',windows:[],status:'available'}),ticket)
  expect(recovered).toMatchObject({snapshot:{status:'available'},transitions:[{before:status,after:'available'}]})
  expect(recovered.snapshot?.retained_status).toBeUndefined()
})

it('retains aggregate low evidence while incomplete data remains unknown and accepts explicit fresh recovery before expiry',async()=>{
  const ticket=await bind()
  await quotas.ingest(observation({windows:[],status:'low'}),ticket)
  now='2026-10-20T10:02:00.000Z'
  const partial=await quotas.ingest(observation({observed_at:now,windows:[],status:'unknown',complete:false}),ticket)
  expect(partial.snapshot).toMatchObject({status:'unknown',retained_status:{status:'low',observed_at:start,expires_at:future}})
  now='2026-10-20T10:03:00.000Z'
  const recovered=await quotas.ingest(observation({observed_at:now,windows:[],status:'available'}),ticket)
  expect(recovered).toMatchObject({snapshot:{status:'available'},transitions:[{before:'low',after:'available'}]})
})

it('allows a complete native numeric response to resolve an aggregate cooldown without erasing independent window constraints',async()=>{
  const ticket=await bind()
  await quotas.ingest(observation({windows:[],status:'cooldown'}),ticket)
  now='2026-10-20T10:02:00.000Z'
  expect((await quotas.ingest(observation({observed_at:now}),ticket)).snapshot?.status).toBe('available')
  now='2026-10-20T10:03:00.000Z'
  await quotas.ingest(observation({observed_at:now,windows:[{id:'weekly',unit:'percent',used:100}],status:'cooldown'}),ticket)
  now='2026-10-20T10:04:00.000Z'
  expect((await quotas.ingest(observation({observed_at:now,windows:[],status:'available'}),ticket)).snapshot?.status).toBe('exhausted')
})

it('keeps unknown model pool observations visible without claiming availability for an arbitrary model',async()=>{
  const ticket=await bind()
  await quotas.ingest(observation({pool_id:'native-dedicated-pool',model_scope:'unknown',windows:[{id:'primary',unit:'percent',used:100}]}),ticket)
  expect((await quotas.list({model:'unrelated-model'}))[0]).toMatchObject({status:'exhausted',model_scope:'unknown',model_ids:[]})
  expect(await quotas.forCli('codex_cli','unrelated-model')).toMatchObject({status:'unknown',reason:'unknown_model_scope'})
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'unknown',reason:'unknown_model_scope'})
  now='2026-10-20T10:01:00.000Z'
  expect((await quotas.ingest(observation({pool_id:'native-dedicated-pool',model_scope:'unknown',observed_at:now,
    windows:[{id:'primary',unit:'percent',used:20}]}),ticket)).snapshot?.status).toBe('available')
  expect(await quotas.forCli('codex_cli','unrelated-model')).toMatchObject({status:'unknown',reason:'unknown_model_scope'})
})

it('lets a confirmed global exhaustion dominate unknown model scopes without summing their quotas',async()=>{
  const ticket=await bind()
  await quotas.ingest(observation({pool_id:'global',model_scope:'all',status:'exhausted'}),ticket)
  await quotas.ingest(observation({pool_id:'unmapped-pool',model_scope:'unknown'}),ticket)
  const result=await quotas.forCli('codex_cli','any-model')
  expect(result.status).toBe('exhausted');expect(result.reason).toBeUndefined();expect(result.pools).toHaveLength(2)
})

it('validates explicit model applicability while preserving legacy listed and global observations',async()=>{
  const ticket=await bind()
  await expect(quotas.ingest(observation({model_scope:'listed'}),ticket)).rejects.toBeTruthy()
  await expect(quotas.ingest(observation({model_scope:'listed',model_ids:[]}),ticket)).rejects.toBeTruthy()
  await expect(quotas.ingest(observation({model_scope:'unknown',model_ids:['invented']}),ticket)).rejects.toBeTruthy()
  await expect(quotas.ingest(observation({model_scope:'all',model_ids:['contradiction']}),ticket)).rejects.toBeTruthy()
  await quotas.ingest(observation({pool_id:'listed',model_scope:'listed',model_ids:['large'],status:'exhausted'}),ticket)
  await quotas.ingest(observation({pool_id:'global',model_scope:'all'}),ticket)
  expect(await quotas.forCli('codex_cli','large')).toMatchObject({status:'exhausted'})
  expect(await quotas.forCli('codex_cli','small')).toMatchObject({status:'available'})
  expect((await quotas.ingest(observation({pool_id:'legacy-global'}),ticket)).snapshot?.model_scope).toBe('all')
  expect((await quotas.ingest(observation({pool_id:'legacy-listed',model_ids:['large']}),ticket)).snapshot?.model_scope).toBe('listed')
})

it('treats a second verified profile without a sample as account ambiguity instead of reusing another account balance',async()=>{
  const first=await bind('installed:profile:first','account-first')
  await quotas.ingest(observation({account_ref:'account-first'}),first)
  const second=await bind('installed:profile:second','account-second')
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'unknown',reason:'ambiguous_account'})
  expect(await quotas.forCli('codex_cli',undefined,{binding_id:second.binding_id})).toMatchObject({status:'unknown',reason:'no_observation',pools:[]})
  expect(await quotas.forCli('codex_cli',undefined,{binding_id:first.binding_id})).toMatchObject({status:'available'})
  expect(await quotas.forCli('codex_cli',undefined,{account_ref:'account-first'})).toMatchObject({status:'available'})
  expect(await quotas.forCli('codex_cli',undefined,{account_ref:'account-second'})).toMatchObject({status:'unknown',reason:'no_observation'})
})

it('does not assume an unverified profile shares the account of the only observed profile',async()=>{
  const first=await bind('installed:profile:verified')
  await quotas.ingest(observation(),first)
  await quotas.bind({binding_id:'installed:profile:unknown',cli:'codex_cli',provider:'openai',sample_started_at:start})
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'unknown',reason:'ambiguous_account'})
  expect(await quotas.forCli('codex_cli',undefined,{binding_id:'installed:profile:unknown'})).toMatchObject({status:'unknown',reason:'no_observation'})
})

it('reuses verified account constraints for another profile before its first sample while respecting provider and CLI filters',async()=>{
  const first=await bind('installed:profile:first')
  await quotas.ingest(observation(),first)
  const same=await bind('installed:profile:same')
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'available'})
  expect(await quotas.forCli('codex_cli',undefined,{binding_id:same.binding_id})).toMatchObject({status:'available'})
  await quotas.bind({binding_id:'another-provider:profile:first',cli:'codex_cli',provider:'other-provider',account_ref:'opaque-account',sample_started_at:start})
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'unknown',reason:'ambiguous_account'})
  expect(await quotas.forCli('codex_cli',undefined,{provider:'openai'})).toMatchObject({status:'available'})
  expect(await quotas.forCli('codex_cli',undefined,{provider:'other-provider'})).toMatchObject({status:'unknown',reason:'no_observation'})
  expect(await quotas.forCli('kiro',undefined,{binding_id:same.binding_id})).toMatchObject({status:'unknown',reason:'no_observation'})
})

it('keeps multiple unobserved profiles ambiguous and releases the old account scope after a profile switch',async()=>{
  await bind('installed:profile:first','account-first')
  await bind('installed:profile:second','account-second')
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'unknown',reason:'ambiguous_account',pools:[]})
  now='2026-10-20T10:02:00.000Z'
  const switched=await bind('installed:profile:second','account-first',now)
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'unknown',reason:'no_observation'})
  await quotas.ingest(observation({account_ref:'account-first',observed_at:now}),switched)
  expect(await quotas.forCli('codex_cli')).toMatchObject({status:'available'})
})

it('correlates CLI, binding, provider and account filters on the same active binding',async()=>{
  const codex=await bind('profile-A')
  await quotas.bind({binding_id:'profile-B',cli:'other_cli',provider:'openai',account_ref:'opaque-account',sample_started_at:start})
  await quotas.ingest(observation({model_scope:'all'}),codex)
  // Both CLIs really appear in the shared pool: independently matching the two arrays would be incorrect.
  expect((await quotas.list())[0]?.clis).toEqual(['codex_cli','other_cli'])
  expect(await quotas.list({cli:'other_cli',binding_id:'profile-A'})).toEqual([])
  expect(await quotas.forCli('other_cli',undefined,{binding_id:'profile-A'})).toEqual({status:'unknown',reason:'no_observation',pools:[]})
  expect(await quotas.list({cli:'codex_cli',binding_id:'profile-B'})).toEqual([])
  expect(await quotas.forCli('codex_cli',undefined,{binding_id:'profile-B'})).toEqual({status:'unknown',reason:'no_observation',pools:[]})
  expect(await quotas.forCli('other_cli',undefined,{binding_id:'profile-B',provider:'openai',account_ref:'opaque-account'})).toMatchObject({status:'available'})
  expect(await quotas.forCli('other_cli',undefined,{binding_id:'profile-B',provider:'other-provider'})).toMatchObject({status:'unknown',reason:'no_observation',pools:[]})
  expect(await quotas.list({cli:'other_cli',binding_id:'profile-B',account_ref:'other-account'})).toEqual([])
})

it('reports the pool that was exhausted at an instant, tolerating a late observation and ignoring other times',async()=>{
  const ticket=await bind()
  await quotas.ingest(observation({observed_at:'2026-10-20T10:00:30.000Z',status:'exhausted'}),ticket)
  now='2026-10-20T10:10:00.000Z'
  await quotas.ingest(observation({observed_at:now,expires_at:'2026-10-20T10:25:00.000Z'}),ticket)
  const key=(await quotas.list())[0]!.id
  expect(await quotas.exhaustedAt('codex_cli','any-model','2026-10-20T10:01:00.000Z')).toEqual({pool_key:key})
  expect(await quotas.exhaustedAt('codex_cli','any-model','2026-10-20T10:00:00.000Z')).toEqual({pool_key:key})
  expect(await quotas.exhaustedAt('codex_cli','any-model','2026-10-20T09:57:00.000Z')).toBeUndefined()
  expect(await quotas.exhaustedAt('codex_cli','any-model','2026-10-20T10:12:00.000Z')).toBeUndefined()
  expect(await quotas.exhaustedAt('claude_code','any-model','2026-10-20T10:01:00.000Z')).toBeUndefined()
})

it('does not treat a pool of unknown model scope or an ambiguous account as exhaustion evidence',async()=>{
  const first=await bind('first','account-a'),second=await bind('second','account-b')
  await quotas.ingest(observation({account_ref:'account-a',observed_at:'2026-10-20T10:00:30.000Z',status:'exhausted'}),first)
  await quotas.ingest(observation({account_ref:'account-b',observed_at:'2026-10-20T10:00:30.000Z',status:'exhausted'}),second)
  expect(await quotas.exhaustedAt('codex_cli','any-model','2026-10-20T10:01:00.000Z')).toBeUndefined()
})
