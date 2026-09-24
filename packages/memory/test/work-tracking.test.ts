import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryOperations } from '../src/operations.js'
import { MemoryAI } from '../src/ai.js'
import { Vault, defaultAI } from '../src/config.js'
import { MemoryError } from '../src/contracts.js'
import { processVersion } from '../src/processing.js'
import { type AgentContext } from '../src/agents.js'
import { exportMemory, readBackup, restoreMemory } from '../src/backup.js'
import { syncJira } from '../src/connectors/jira.js'
import { ProviderHttp } from '../src/connectors/http.js'
import type { ConnectorContext, Connector } from '../src/connectors/types.js'

const url = process.env.AGENTHUB_MEMORY_TEST_URL
describe.skipIf(!url)('proyectos, tareas y agentes con PostgreSQL real', () => {
  let db: MemoryDatabase, store: MemoryStore, directory: string, ops: MemoryOperations, vault: Vault
  const config = { ...defaultAI, extraction: 'ollama' as const, extraction_model: 'fixture' }
  const signal = () => new AbortController().signal
  const agent: AgentContext = { agent_id: 'agent-a', cli_kind: 'codex_cli', client: 'test', session_id: 'session-a-test', cwd: '/work/api' }
  const issue = (status = 'To Do', updated = '2026-01-01T00:00:00Z') => ({ key: 'APP-1', fields: { summary: 'Implementar API', updated,
    status: { name: status, statusCategory: { key: status === 'Done' ? 'done' : 'new' } }, issuetype: { name: 'Task' } } })
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Se requiere una base de pruebas')
    directory = await mkdtemp(join(tmpdir(), 'memory-work-test-'))
    db = new MemoryDatabase(url!); await db.migrate()
    store = new MemoryStore(db, directory); vault = new Vault(directory)
    ops = new MemoryOperations(store, new MemoryAI(async () => defaultAI, vault), undefined, vault)
  })
  beforeEach(async () => {
    const tables = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='agenthub_memory' AND tablename<>'schema_versions'")
    await db.query(`TRUNCATE ${tables.map(t => `"${t.tablename}"`).join(',')} RESTART IDENTITY CASCADE`)
  })
  afterAll(async () => { await db?.close(); if (directory) await rm(directory, { recursive: true, force: true }) })
  async function project() { return store.create({ kind: 'project', title: 'API', data: { folders: ['/work/api'], jira_project_key: 'APP' } }) }
  function model(ref: string, confidence = 'high') {
    return { extract: vi.fn(async (_instructions: string, content: any) => ({ value: content.projects?.[0]?.id === 'p1' || 'extracted_facts' in content
      ? { verdicts: [{ project_ref: ref, confidence, reason: 'Se menciona API.', evidence_ids: ['f1'], suggested_title: 'API nueva', suggested_description: 'Trabajo nuevo' }] }
      : { facts: [{ category: 'decision', text: 'Implementar la API.', evidence_ids: [content.fragments[0].id], project_ids: [] }] },
    usage: { model: 'fixture', input_tokens: 10, output_tokens: 5 } })) } as unknown as MemoryAI
  }
  it('asigna reunión, documento, evento y hechos; buscar sin proyecto los excluye', async () => {
    const p = await project()
    const meeting = await store.ingest({ kind: 'meeting', title: 'API', external_id: 'meeting', text: 'Implementar API.' })
    const doc = await store.ingest({ kind: 'document', title: 'Transcript', external_id: 'doc', text: 'Implementar API.' })
    const event = await store.create({ kind: 'event', title: 'Invitación' })
    await store.link({ from_id: meeting.entity_id, to_id: doc.entity_id, type: 'meeting_document' })
    await store.link({ from_id: meeting.entity_id, to_id: event.id, type: 'calendar_event' })
    await processVersion(store, model('p1'), meeting.version_id, config, async () => {}, signal())
    const related = await store.list({ project_id: p.id })
    expect(related.items.map(e => e.id)).toEqual(expect.arrayContaining([meeting.entity_id, doc.entity_id, event.id]))
    expect(related.items.some(e => e.kind === 'fact' && e.data.category === 'decision')).toBe(true)
    expect((await ops.call('search', { query: '', mode: 'text', project_id: p.id })).total).toBe(2)
    expect((await ops.call('search', { query: '', mode: 'text', unassigned: true })).total).toBe(0)
  })
  it.each(['assign', 'create', 'none'])('permite resolver una propuesta con %s y no duplica hechos', async decision => {
    const p = await project(), ai = model('none', 'low')
    const source = await store.ingest({ kind: 'meeting', title: 'Trabajo nuevo', external_id: 'suggest', text: 'Implementar API.' })
    await processVersion(store, ai, source.version_id, config, async () => {}, signal())
    const proposal = (await ops.call('list_project_suggestions', {})).items[0]
    expect(proposal.fact_count).toBe(1)
    const result = await ops.call('review_project_suggestion', { id: proposal.id, decision,
      ...(decision === 'assign' ? { project_id: p.id } : decision === 'create' ? { title: 'Nuevo' } : {}) })
    expect((await ops.call('list_project_suggestions', {})).total).toBe(0)
    await processVersion(store, ai, source.version_id, config, async () => {}, signal())
    expect(ai.extract).toHaveBeenCalledTimes(2)
    if (result.project_id) expect((await store.list({ kind: 'fact', project_id: result.project_id })).total).toBe(1)
  })
  it('dos revisiones concurrentes crean un solo proyecto y una falla revierte toda la asignación', async () => {
    const source = await store.ingest({kind:'meeting',title:'Trabajo',external_id:'concurrent-review',text:'Implementar API.'})
    await processVersion(store,model('none'),source.version_id,config,async()=>{},signal())
    const proposal = (await ops.call('list_project_suggestions',{})).items[0]
    const original = store.link.bind(store)
    const failure = vi.spyOn(store,'link').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('fixture rollback') })
    await expect(ops.call('review_project_suggestion',{id:proposal.id,decision:'create',title:'Nuevo'})).rejects.toThrow('fixture rollback')
    failure.mockRestore()
    expect((await store.list({kind:'project'})).total).toBe(0)
    expect((await ops.call('list_project_suggestions',{})).total).toBe(1)
    const reviews = await Promise.allSettled([1,2].map(()=>ops.call('review_project_suggestion',{id:proposal.id,decision:'create',title:'Nuevo'})))
    expect(reviews.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect((await store.list({kind:'project'})).total).toBe(1)
    expect((await ops.call('list_project_suggestions',{})).total).toBe(0)
  })
  it('reanuda el lote pendiente sin duplicar hechos tras fallar el proveedor', async () => {
    const p = await project()
    const source = await store.ingest({ kind: 'meeting', title: 'Larga', external_id: 'long', project_ids: [p.id],
      fragments: Array.from({ length: 41 }, (_, i) => ({ text: `Punto ${i}.` })) })
    let calls = 0
    const ai = { extract: vi.fn(async (_i: string, content: any) => {
      if (++calls === 2) throw new MemoryError(503, 'Temporal', true)
      return { value: { facts: [{ category: 'finding', text: content.fragments[0].text, evidence_ids: [content.fragments[0].id], project_ids: [] }] },
        usage: { model: 'fixture', input_tokens: 1, output_tokens: 1 } }
    }) } as unknown as MemoryAI
    await expect(processVersion(store, ai, source.version_id, config, async () => {}, signal(), true, false, { runKey: 'job' })).rejects.toThrow('Temporal')
    await processVersion(store, ai, source.version_id, config, async () => {}, signal(), true, false, { runKey: 'job' })
    expect(ai.extract).toHaveBeenCalledTimes(3)
    expect((await store.list({ kind: 'fact', project_id: p.id })).total).toBe(2)
  })
  it('no convierte una respuesta inválida en una decisión definitiva de proyecto', async () => {
    await project()
    const source = await store.ingest({ kind: 'meeting', title: 'API', external_id: 'invalid', text: 'Implementar API.' })
    const ai = model('p999')
    const progress: any[] = []
    await processVersion(store, ai, source.version_id, config, async p => { progress.push(p) }, signal())
    expect(progress.some(p => p.project_inference === 'failed')).toBe(true)
    expect((await ops.call('list_project_suggestions', {})).total).toBe(0)
    expect((await store.list({ kind: 'fact' })).total).toBe(1)
    expect((await db.query('SELECT metadata FROM versions WHERE id=$1', [source.version_id]))[0]!.metadata.project_inference_key).toBeUndefined()
  })
  it('asociar una fuente no mezcla hechos de segmentos asignados explícitamente a otro proyecto', async () => {
    const p = await project(), other = await store.create({ kind: 'project', title: 'Otro' })
    const source = await store.ingest({ kind: 'meeting', title: 'Mixta', external_id: 'mixed', text: 'Implementar API.' })
    const fragment = (await store.fragments(source.entity_id)).items[0]!
    await store.assignFragment(fragment.id, [other.id])
    await processVersion(store, model('none'), source.version_id, config, async () => {}, signal())
    await store.link({ from_id: source.entity_id, to_id: p.id, type: 'project' })
    expect((await store.list({ kind: 'fact', project_id: p.id })).total).toBe(0)
    expect((await store.list({ kind: 'fact', project_id: other.id })).total).toBe(1)
  })
  it('sincroniza Jira desde dos agentes, preserva el estado nuevo y registra cambios de descripción', async () => {
    const p = await project()
    const results = await Promise.all([ops.call('sync_tasks', { issues: [issue()] }), ops.call('sync_tasks', { issues: [issue()] })])
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(1)
    const fresh = issue('Done', '2026-02-01T00:00:00Z')
    await ops.call('sync_tasks', { issues: [fresh] })
    await ops.call('sync_tasks', { issues: [issue()] })
    await ops.call('sync_tasks', { issues: [{ ...fresh, fields: { ...fresh.fields, description: 'Detalle actualizado' } }] })
    const tasks = await ops.call('list_tasks', { project_id: p.id })
    expect(tasks.items).toHaveLength(1)
    expect(tasks.items[0]).toMatchObject({ status: 'done', external_status: 'Done', description: 'Detalle actualizado' })
    expect((await ops.call('get_task', { id: tasks.items[0].id })).events.filter((e: any) => e.action === 'status')).toHaveLength(1)
  })
  it('actualiza también el tablero de tareas al sincronizar el conector Jira', async () => {
    const p = await project()
    const connector = await ops.call('save_connector', { provider: 'jira', name: 'Jira', config: { site_url: 'https://example.atlassian.net', jql: 'project=APP' } })
    vault.save(connector.id, { email: 'fixture@example.com', token: 'fixture' })
    const http = new ProviderHttp(async url => new Response(JSON.stringify(String(url).includes('search/jql')
      ? { issues: [{ id: '1', ...issue('Done') }], isLast: true } : { comments: [], total: 0 })))
    await syncJira(connector as Connector, { store, vault, http, signal: signal(), progress: async () => {} } as ConnectorContext)
    expect((await ops.call('list_tasks', { project_id: p.id })).items[0]).toMatchObject({ external_key: 'APP-1', status: 'done' })
  })
  it('sin token reutiliza Jira MCP y persiste todas las páginas dentro del proyecto indicado', async () => {
    const p = await project()
    const read = vi.fn(async (_request, onPage) => {
      await onPage([issue('Done')], 'https://example.atlassian.net')
      await onPage([{ ...issue(), key: 'APP-2' }], 'https://example.atlassian.net')
    })
    const withMcp = new MemoryOperations(store, new MemoryAI(async () => defaultAI, vault), undefined, vault, fetch, read)
    const result = await withMcp.call('sync_tasks', { project_id: p.id }, 'mcp', agent)
    expect(result).toMatchObject({ received: 2, created: 2, unmatched: [] })
    expect(read.mock.calls[0]![0]).toEqual({ key: 'APP', site: null, agentId: agent.agent_id })
    const tasks = await withMcp.call('list_tasks', { project_id: p.id })
    expect(tasks.total).toBe(2)
    expect(tasks.items.find((t: any) => t.external_key === 'APP-1')).toMatchObject({ status: 'done', external_status: 'Done' })
    expect((await store.detail(p.id)).entity.data.jira_synced_at).toBeTruthy()
  })
  it('separa claves Jira iguales de dos sitios y rechaza una sincronización ambigua', async () => {
    const projects = []
    for (const site of ['a','b']) projects.push(await store.create({ kind:'project',title:site,data:{ jira_project_key:'APP',jira_site_url:`https://${site}.atlassian.net` } }))
    for (const [i,site] of ['a','b'].entries()) await ops.call('sync_tasks',{ site_url:`https://${site}.atlassian.net`,issues:[issue(i === 0 ? 'Done':'To Do')] })
    expect((await ops.call('list_tasks',{project_id:projects[0]!.id})).items[0].status).toBe('done')
    expect((await ops.call('list_tasks',{project_id:projects[1]!.id})).items[0].status).toBe('todo')
    expect((await ops.call('sync_tasks',{issues:[issue('Done')]})).unmatched).toEqual(['APP-1'])
    expect((await ops.call('list_tasks',{})).total).toBe(2)
  })
  it('un fin de turno atrasado no cierra la nota del turno siguiente ni la de otro agente', async () => {
    await project()
    const first = await ops.call('write_note',{text:'Turno uno'},'mcp',agent)
    const cutoff = new Date().toISOString()
    await db.query("UPDATE agent_notes SET updated_at=now()-interval '1 second' WHERE id=$1",[first.id])
    await ops.call('finish_notes',{reason:'turn_end',before:cutoff},'mcp',agent)
    const second = await ops.call('write_note',{text:'Turno dos'},'mcp',agent)
    await db.query("UPDATE agent_notes SET updated_at=$2::timestamptz+interval '1 second' WHERE id=$1",[second.id,cutoff])
    const other = await ops.call('write_note',{text:'Otro agente'},'mcp',{...agent,session_id:'other-agent-session'})
    await ops.call('finish_notes',{reason:'turn_end',before:cutoff},'mcp',agent)
    const notes = (await ops.call('list_notes',{})).items
    expect(notes.find((n:any)=>n.id===first.id)).toMatchObject({state:'done',finish_reason:'turn_end'})
    expect(notes.filter((n:any)=>[second.id,other.id].includes(n.id)).every((n:any)=>n.state==='working')).toBe(true)
  })
  it('atribuye notas a sesiones, respeta su proyecto al editarlas y detecta carpetas agregadas', async () => {
    await ops.call('context', {}, 'mcp', agent)
    const p = await project()
    const note = await ops.call('write_note', { text: 'Implementando' }, 'mcp', agent)
    expect(note).toMatchObject({ project_id: p.id, session_id: agent.session_id })
    await expect(ops.call('write_note', { id: note.id, text: 'Cambio' }, 'mcp', { ...agent, session_id: 'another-session' })).rejects.toMatchObject({ statusCode: 403 })
    const moved = { ...agent, cwd: '/other' }
    expect(await ops.call('write_note', { id: note.id, text: 'Actualizado' }, 'mcp', moved)).toMatchObject({ project_id: p.id })
    expect((await ops.call('context', { path: '/work/api/subdir' })).project.id).toBe(p.id)
    expect((await ops.call('context', { path: '/work/api-other' })).project).toBeNull()
    await ops.call('finish_notes', { summary: 'Terminado' }, 'mcp', agent)
    expect((await ops.call('list_notes', { project_id: p.id })).items[0]).toMatchObject({ state: 'done', text: 'Terminado' })
  })
  it('cuenta todas las tareas sin movimiento y restaura tareas y notas desde backup', async () => {
    const p = await project()
    for (let i = 0; i < 23; i++) await ops.call('save_task', { project_id: p.id, title: `Pendiente ${i}`, origin: 'code' })
    await db.query("UPDATE tasks SET updated_at=now()-interval '30 days'")
    const stats = await ops.call('task_stats', { project_id: p.id })
    expect(stats.summary.stale_open).toBe(23); expect(stats.stale).toHaveLength(20)
    await ops.call('write_note', { text: 'Revisando pendientes' }, 'mcp', agent)
    const backup = await exportMemory(store)
    const data = JSON.parse(await readBackup(store, backup.id))
    await db.query('TRUNCATE entities CASCADE')
    await db.query('TRUNCATE agent_sessions CASCADE')
    await db.query('TRUNCATE changes')
    await restoreMemory(store, data)
    expect((await ops.call('list_tasks', { project_id: p.id })).total).toBe(23)
    expect((await ops.call('list_notes', { project_id: p.id })).total).toBe(1)
    await ops.call('save_task', { project_id: p.id, title: 'Después de restaurar' })
  })
  it('sincronizar ahora adelanta reintentos y encola sólo fuentes activas', async () => {
    const active = await ops.call('save_connector', { provider: 'google', name: 'Activa', enabled: true, config: {} })
    await ops.call('save_connector', { provider: 'google', name: 'Pausada', enabled: false, config: {} })
    await db.query("UPDATE jobs SET state='waiting',available_at=now()+interval '1 hour' WHERE kind='sync'")
    expect((await ops.call('sync_sources', {})).queued).toBe(1)
    const jobs = await db.query("SELECT *,available_at<=now() AS ready FROM jobs WHERE kind='sync'")
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ payload: { connector_id: active.id }, ready: true })
  })
})
