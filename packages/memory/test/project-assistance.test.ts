import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import type { MemoryAI } from '../src/ai.js'
import { defaultAI } from '../src/config.js'
import { draftProfile, saveProjectCompany, suggestProjects } from '../src/project-assistance.js'

const url=process.env.AGENTHUB_MEMORY_TEST_URL
describe.skipIf(!url)('asistencia contextual con PostgreSQL',() => {
  let db:MemoryDatabase,store:MemoryStore,directory:string
  beforeAll(async() => { if(!new URL(url!).pathname.endsWith('_test')) throw new Error('Base de pruebas requerida')
    directory=await mkdtemp(join(tmpdir(),'assistance-test-'));db=new MemoryDatabase(url!);await db.migrate();store=new MemoryStore(db,directory) })
  beforeEach(async() => { const tables=await db.query("SELECT tablename FROM pg_tables WHERE schemaname='agenthub_memory' AND tablename<>'schema_versions'")
    await db.query(`TRUNCATE ${tables.map(t=>`"${t.tablename}"`).join(',')} RESTART IDENTITY CASCADE`)
    await db.query("INSERT INTO settings(key,value) VALUES('ai',$1)",[JSON.stringify({...defaultAI,extraction:'ollama'})]) })
  afterAll(async() => {await db?.close();if(directory)await rm(directory,{recursive:true,force:true})})
  const localOnly={embedQuery:vi.fn(async()=>{throw new Error('Ollama offline')})} as unknown as MemoryAI
  async function project(title='Proyecto',data={}) {return store.create({kind:'project',title,data})}
  async function source(p:string,title:string,text:string,metadata={}) {return store.ingest({kind:'meeting',title,text,external_id:crypto.randomUUID(),project_ids:[p],metadata})}
  function model(transform=(v:any)=>v) {
    const extract=vi.fn(async(_instructions:string,content:any)=>({value:transform({title:'Empresa Cliente',description:'Comercializa insumos para restaurantes.',evidence_ids:[content.fragments[0].id],warnings:[]}),usage:{input_tokens:1,output_tokens:1,model:'fixture'}}))
    return {extract,forJob:()=>({extract})} as unknown as MemoryAI
  }
  it('encuentra un proyecto antiguo entre más de 200 por el nombre de su empresa sin embeddings',async() => {
    const company=await store.create({kind:'company',title:'Órbita SA'}),p=await project('Plataforma comercial',{company_id:company.id})
    await db.query("INSERT INTO entities(id,kind,title,data) SELECT gen_random_uuid(),'project','Otro '||i,'{}' FROM generate_series(1,220) i")
    const meeting=await store.ingest({kind:'meeting',title:'Orbita SA — Assessment',text:'Presentación del negocio.',external_id:'source'})
    const result=await suggestProjects(store,localOnly,{entity_id:meeting.entity_id})
    expect(result.selected_id).toBe(p.id);expect(result.semantic_status).toBe('unavailable')
    expect((await store.list({kind:'project',query:'Órbita'})).items.map(p=>p.id)).toEqual([p.id])
    expect((await store.detail(meeting.entity_id)).links).toHaveLength(0)
  })
  it('no preselecciona cuando dos proyectos tienen el mismo cliente',async() => {
    const c=await store.create({kind:'company',title:'Órbita'});await project('Ventas',{company_id:c.id});await project('Operaciones',{company_id:c.id})
    const s=await store.ingest({kind:'meeting',title:'Órbita daily',text:'Reunión',external_id:'s'})
    expect((await suggestProjects(store,localOnly,{entity_id:s.entity_id})).selected_id).toBeNull()
  })
  it('usa vectores vigentes para encontrar significado aunque el nombre no aparezca',async() => {
    const p=await project('Plataforma de restaurantes')
    await db.query(`INSERT INTO entity_embeddings(entity_id,model,dimension,embedding,content_hash)
      SELECT id,'test',3,'[1,0,0]'::vector,md5(memory_entity_text(title,data)) FROM entities WHERE id=$1`,[p.id])
    const s=await store.ingest({kind:'document',title:'Gestión de pedidos gastronómicos',text:'Propuesta comercial',external_id:'s'})
    const ai={embedQuery:async()=>({model:'test',vectors:[[1,0,0]]})} as unknown as MemoryAI
    expect((await suggestProjects(store,ai,{entity_id:s.entity_id})).selected_id).toBe(p.id)
    await store.update(p.id,{data:{description:'Cambió el contenido'}})
    expect((await suggestProjects(store,ai,{entity_id:s.entity_id})).selected_id).toBeNull()
  })
  it('genera sólo una preview con citas actuales y prioriza assessment; excluye fuentes protegidas',async() => {
    const p=await project();await source(p.id,'Daily','Hablamos del avance.')
    await source(p.id,'Assessment inicial','La dueña explica: vendemos insumos para restaurantes.')
    await source(p.id,'Venta secreta','SECRETO NO EXPORTAR',{remote_processing:false})
    await db.query("UPDATE settings SET value=$1 WHERE key='ai'",[JSON.stringify({...defaultAI,extraction:'opencode',remote_processing_enabled:true})])
    const ai=model(),before=await store.list({kind:'company'})
    const draft=await draftProfile(store,ai,{project_id:p.id,kind:'company'})
    expect(draft.description).toContain('restaurantes');expect(draft.sources[0]!.title).toBe('Assessment inicial')
    const payload=vi.mocked(ai.extract).mock.calls[0]![1] as any
    expect(JSON.stringify(payload)).not.toContain('SECRETO');expect(payload.fragments[0].source).toBe('Assessment inicial')
    expect((await store.list({kind:'company'})).total).toBe(before.total)
    expect((await store.detail(p.id)).entity.data.company_id).toBeUndefined()
    await store.update(p.id,{data:{remote_processing:false}})
    await expect(draftProfile(store,ai,{project_id:p.id,kind:'project'})).rejects.toMatchObject({statusCode:409})
    expect(ai.extract).toHaveBeenCalledTimes(1)
  })
  it('rechaza evidencia inventada y proyectos sin contenido',async() => {
    const p=await project();await expect(draftProfile(store,model(),{project_id:p.id,kind:'project'})).rejects.toMatchObject({statusCode:409})
    await source(p.id,'Assessment','Somos una empresa de gastronomía.')
    await expect(draftProfile(store,model(v=>({...v,evidence_ids:['f9999']})),{project_id:p.id,kind:'company'})).rejects.toMatchObject({statusCode:502})
  })
  it('crea y asocia una sola vez; un conflicto no deja empresas huérfanas',async() => {
    const p=await project(),input={project_id:p.id,expected_updated_at:p.updated_at,company:{title:'Empresa editada',description:'Descripción revisada.'}}
    const result=await saveProjectCompany(store,input,'test')
    const detail=await store.detail(p.id)
    expect(detail.entity.data.company_id).toBe(result.company.id);expect(detail.links.filter(l=>l.type==='company')).toHaveLength(1)
    await expect(saveProjectCompany(store,input,'test')).rejects.toMatchObject({statusCode:409})
    expect((await store.list({kind:'company'})).total).toBe(1)
  })
})
