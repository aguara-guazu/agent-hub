import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {MemoryDatabase} from '../../memory/dist/database.js'
import {UsageQuotas} from '../../memory/dist/usage-quotas.js'
import {codexQuotas} from './usage-quota-adapters.js'

let directory:string,db:MemoryDatabase,quotas:UsageQuotas,now:number
const start=Date.parse('2026-10-20T12:00:00Z')
const response=(usedPercent:number)=>({rateLimits:{limitId:'codex',primary:{usedPercent,windowDurationMins:300,resetsAt:(start+3600000)/1000},secondary:null}})
beforeEach(async()=>{
 now=start;directory=await mkdtemp(join(tmpdir(),'quota-adapter-recovery-'))
 db=new MemoryDatabase(join(directory,'memory.sqlite'));await db.migrate()
 quotas=new UsageQuotas(db,()=>new Date(now).toISOString())
})
afterEach(async()=>{await db.close();await rm(directory,{recursive:true,force:true})})
const binding=()=>quotas.bind({binding_id:'installed:profile:default',cli:'codex_cli',provider:'openai',account_ref:'opaque-account',sample_started_at:new Date(now).toISOString()})
it('una lectura vacía no crea pools provisionales que impidan recuperarse a disponible',async()=>{
 const ticket=await binding()
 const empty=codexQuotas({},'opaque-account',now)
 expect(empty).toEqual([])
 for(const observation of empty)await quotas.ingest(observation,ticket)
 expect(await quotas.list()).toEqual([])
 expect(await quotas.forCli('codex_cli','a-model',{binding_id:ticket.binding_id})).toMatchObject({status:'unknown',reason:'no_observation'})
 now+=60000
 for(const observation of codexQuotas(response(20),'opaque-account',now))await quotas.ingest(observation,ticket)
 expect((await quotas.list()).map(pool=>pool.pool_id)).toEqual(['codex'])
 expect(await quotas.forCli('codex_cli','a-model',{binding_id:ticket.binding_id})).toMatchObject({status:'available'})
})
it('omitir una lectura vacía no borra una restricción real ni renueva su TTL',async()=>{
 const ticket=await binding()
 for(const observation of codexQuotas(response(100),'opaque-account',now))await quotas.ingest(observation,ticket)
 now+=60000
 for(const observation of codexQuotas({},'opaque-account',now))await quotas.ingest(observation,ticket)
 const pools=await quotas.list()
 expect(pools).toHaveLength(1);expect(pools[0]?.observation.observed_at).toBe(new Date(start).toISOString())
 expect(await quotas.forCli('codex_cli',undefined,{binding_id:ticket.binding_id})).toMatchObject({status:'exhausted'})
 now=start+301000
 expect(await quotas.forCli('codex_cli',undefined,{binding_id:ticket.binding_id})).toMatchObject({status:'unknown'})
 now+=1000
 for(const observation of codexQuotas(response(10),'opaque-account',now))await quotas.ingest(observation,ticket)
 expect(await quotas.forCli('codex_cli',undefined,{binding_id:ticket.binding_id})).toMatchObject({status:'available'})
})
