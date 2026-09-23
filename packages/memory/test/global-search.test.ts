import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryAI } from '../src/ai.js'
import { Vault, defaultAI, type AIConfig } from '../src/config.js'
import { globalSearch } from '../src/global-search.js'
import { indexEntities, scheduleEntityIndex } from '../src/entity-index.js'
import { processVersion } from '../src/processing.js'
import { JobRunner } from '../src/jobs.js'
import { GoogleAuth } from '../src/google-auth.js'
import { deleteEntity, exportMemory, restoreMemory } from '../src/backup.js'

const url = process.env.AGENTHUB_MEMORY_TEST_URL
describe.skipIf(!url)('búsqueda global e índice local con PostgreSQL y pgvector', () => {
  let db: MemoryDatabase, store: MemoryStore, directory: string, vault: Vault, ai: MemoryAI, config: AIConfig
  const calls: { model: string; input: string[] }[] = []
  const signal = () => new AbortController().signal
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push(body)
    return new Response(JSON.stringify({ embeddings: body.input.map((text: string) => /arquitectura|microservicios|distribuid/i.test(text) ? [1,0,0] : [0,1,0]) }))
  }
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Se requiere una base dedicada de pruebas')
    directory = await mkdtemp(join(tmpdir(), 'agenthub-search-test-'))
    db = new MemoryDatabase(url!); await db.migrate(); store = new MemoryStore(db, directory); vault = new Vault(directory)
  })
  beforeEach(async () => {
    const tables = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='agenthub_memory' AND tablename<>'schema_versions'")
    await db.query(`TRUNCATE ${tables.map(t => `"${t.tablename}"`).join(',')} RESTART IDENTITY CASCADE`)
    config = { ...defaultAI, embeddings_enabled: true, embedding_model: 'fixture' }
    calls.length = 0; ai = new MemoryAI(async () => ({ ...config }), vault, fetcher)
  })
  afterAll(async () => { await db?.close(); if (directory) await rm(directory, { recursive: true, force: true }) })
  const index = () => indexEntities(store, ai, config, signal(), async () => {})

  it('encuentra por significado proyectos, conocimientos, notas y fragmentos, y abre la evidencia exacta', async () => {
    const project = await store.create({ kind: 'project', title: 'Atlas', data: { description: 'Plataforma distribuida' } })
    const fact = await store.create({ kind: 'fact', title: 'Servicios independientes', data: { text: 'Adoptar microservicios', category: 'decision' }, project_ids: [project.id] })
    const note = await store.create({ kind: 'note', title: 'Diseño técnico', data: { text: 'Despliegue distribuido' } })
    const meeting = await store.ingest({ kind: 'meeting', external_id: 'planning', title: 'Planificación', fragments: [{ text: 'Elegimos microservicios para separar responsabilidades.' }], project_ids: [project.id] })
    await store.create({ kind: 'project', title: 'Campaña de marketing' })
    await index(); await processVersion(store, ai, meeting.version_id, config, async () => {}, signal())
    const result = await globalSearch(db, ai, { query: 'arquitectura' })
    expect(result.semantic_status).toBe('ready')
    expect(new Set(result.items.map(r => r.entity_id))).toEqual(new Set([project.id,fact.id,note.id,meeting.entity_id]))
    const found = result.items.find(r => r.entity_id === meeting.entity_id)!
    expect(found.href).toBe(`/memory/entities/${meeting.entity_id}?version=${meeting.version_id}&fragment=${found.fragment_id}`)
    expect(found.projects).toEqual([{ id: project.id, title: 'Atlas' }])
    expect(result.items.find(r => r.entity_id === project.id)!.href).toBe(`/projects/${project.id}`)
    expect((await globalSearch(db, ai, { query: 'arquitectura', kind: 'fact', project_id: project.id })).items.map(r => r.entity_id)).toEqual([fact.id])
    expect((await globalSearch(db, ai, { query: 'arquitectura', kind: 'note', project_id: project.id })).items).toEqual([])
    expect((await globalSearch(db, ai, { query: 'arquitectura', from: '2099-01-01T00:00:00Z' })).items).toEqual([])
    // Changing filters reuses the query vector while preserving pre-ranking filters.
    expect(calls.filter(c => c.input[0] === 'arquitectura')).toHaveLength(1)
  })

  it('busca por texto sin Ollama, pagina sin duplicados y muestra contenido reciente sin inferencia', async () => {
    config.embeddings_enabled = false
    await store.create({ kind: 'note', title: 'Plan comercial', data: { text: 'Presupuesto de renovación' } })
    await store.create({ kind: 'project', title: 'Renovación de oficinas' })
    await store.ingest({ kind: 'document', external_id: 'duplicate', title: 'Renovación', fragments: [{ text: 'Renovación del espacio' }, { text: 'Renovación fase dos' }] })
    const first = await globalSearch(db, ai, { query: 'renovación', limit: 2 })
    const second = await globalSearch(db, ai, { query: 'renovación', limit: 2, offset: 2 })
    expect(first.semantic_status).toBe('not_configured'); expect(first.has_more).toBe(true)
    expect(second.has_more).toBe(false)
    expect(new Set([...first.items,...second.items].map(r => r.entity_id)).size).toBe(3)
    expect((await globalSearch(db, ai, {})).items).toHaveLength(3)
    expect(calls).toHaveLength(0)
    const offline = new MemoryAI(async () => ({ ...config, embeddings_enabled: true }), vault, async () => { throw new Error('Ollama apagado') })
    expect(await globalSearch(db, offline, { query: 'presupuesto' })).toMatchObject({ semantic_status: 'unavailable', total: 1 })
  })

  it('excluye fuentes históricas, eliminadas, personas fusionadas y propuestas rechazadas', async () => {
    const old = await store.ingest({ kind: 'document', external_id: 'versions', title: 'Guía', text: 'Microservicios anteriores' })
    await processVersion(store, ai, old.version_id, config, async () => {}, signal())
    await store.ingest({ kind: 'document', external_id: 'versions', title: 'Guía', text: 'Marketing actualizado' })
    const deleted = await store.ingest({ kind: 'document', external_id: 'removed', title: 'Microservicios', text: 'Microservicios obsoletos' })
    await db.query("UPDATE sources SET status='deleted' WHERE entity_id=$1", [deleted.entity_id])
    await store.create({ kind: 'fact', title: 'Microservicios rechazados', data: { review_state: 'rejected' } })
    const person = await store.create({ kind: 'person', title: 'Microservicios fusionados' })
    await store.update(person.id, { data: { merged_into: person.id } })
    await index()
    expect((await globalSearch(db, ai, { query: 'microservicios' })).items).toEqual([])
  })

  it('reindexa cambios, ignora vectores viejos y no guarda inferencias de una entidad editada durante el procesamiento', async () => {
    const note = await store.create({ kind: 'note', title: 'Plan', data: { text: 'Microservicios' } })
    await index()
    await store.update(note.id, { data: { text: 'Marketing' } })
    expect((await globalSearch(db, ai, { query: 'arquitectura' })).items).toEqual([])
    const concurrent = new MemoryAI(async () => config, vault, async (url, init) => {
      await store.update(note.id, { data: { text: 'Ventas' } }); return fetcher(url, init)
    })
    await indexEntities(store, concurrent, config, signal(), async () => {})
    expect((await db.query('SELECT content_hash=md5(memory_entity_text(title,data)) AS current FROM entity_embeddings JOIN entities ON id=entity_id'))[0]!.current).toBe(false)
    await index()
    expect((await globalSearch(db, ai, { query: 'ventas' })).semantic_status).toBe('ready')
    await deleteEntity(store, note.id)
    expect(await db.query('SELECT * FROM entity_embeddings')).toEqual([])
  })

  it('descubre datos existentes al activar embeddings y completa el índice desde el worker sin extracción remota', async () => {
    config.embeddings_enabled = false
    await store.create({ kind: 'project', title: 'Microservicios' })
    await store.ingest({ kind: 'meeting', external_id: 'before-setup', title: 'Plan', text: 'Microservicios independientes' })
    const runner = new JobRunner(store, ai, vault, new GoogleAuth(vault, 'http://127.0.0.1/callback'), async () => ({ ...config }))
    await runner.schedule(); await runner.once(signal())
    expect(await db.query('SELECT * FROM entity_embeddings')).toEqual([])
    expect(await db.query('SELECT * FROM embeddings')).toEqual([])
    config.embeddings_enabled = true
    await runner.schedule(); await runner.schedule()
    expect((await db.query("SELECT * FROM jobs WHERE state='queued'"))).toHaveLength(2)
    await runner.once(signal()); await runner.once(signal())
    expect((await db.query('SELECT * FROM entity_embeddings'))).toHaveLength(2)
    expect((await db.query('SELECT * FROM embeddings'))).toHaveLength(1)
    expect((await globalSearch(db, ai, { query: 'arquitectura' })).semantic_status).toBe('ready')
    expect(calls.every(c => c.model === 'fixture')).toBe(true)
    config.embedding_model = 'next-model'
    expect((await globalSearch(db, ai, { query: 'arquitectura' })).semantic_status).toBe('indexing')
    await runner.schedule(); await runner.once(signal()); await runner.once(signal())
    expect((await globalSearch(db, ai, { query: 'arquitectura' })).semantic_status).toBe('ready')
  })

  it('respeta cancelación y evita reintentos continuos del índice cuando el modelo falla', async () => {
    await store.create({ kind: 'project', title: 'Atlas' })
    await scheduleEntityIndex(store, config)
    await db.query("UPDATE jobs SET state='failed'")
    await scheduleEntityIndex(store, config)
    expect((await db.query('SELECT * FROM jobs'))).toHaveLength(1)
    await db.query("UPDATE jobs SET updated_at=now()-interval '6 minutes'")
    await scheduleEntityIndex(store, config)
    expect((await db.query('SELECT * FROM jobs'))).toHaveLength(2)
    const controller = new AbortController(); controller.abort()
    await expect(globalSearch(db, ai, { query: 'Atlas' }, controller.signal)).rejects.toThrow()
    expect(calls).toHaveLength(0)
    const progress = vi.fn()
    await expect(indexEntities(store, ai, config, controller.signal, progress)).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('restaura respaldos anteriores a la migración y regenera el índice derivado', async () => {
    const note = await store.create({ kind: 'note', title: 'Microservicios' })
    await index()
    const backup = await exportMemory(store), content = JSON.parse(await readFile(join(directory, 'backups', `${backup.id}.json`), 'utf8'))
    expect(content.tables.entity_embeddings).toBeUndefined()
    content.schema_version = 1
    await db.query('TRUNCATE entities, changes CASCADE')
    await restoreMemory(store, content)
    expect((await store.detail(note.id)).entity.title).toBe('Microservicios')
    expect(await db.query('SELECT * FROM entity_embeddings')).toEqual([])
    await index()
    expect((await globalSearch(db, ai, { query: 'arquitectura' })).items.map(r => r.entity_id)).toEqual([note.id])
  })
})
