import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryService } from '../src/service.js'
import { tidyMemory } from '../src/memory-maintenance.js'
import { defaultAI } from '../src/config.js'
import { vector } from '../src/database.js'

let service: MemoryService, directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'memory-remember-')); service = new MemoryService(directory, 'http://localhost/callback') })
afterEach(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })
const signal = () => new AbortController().signal
const memory = { key: 'tests', title: 'Validación del proyecto', text: 'Ejecutar las pruebas antes de publicar.', category: 'procedure' }
it('guarda recuerdos idempotentes y corrige con control de versión y evidencia', async () => {
  const { operations, store } = await service.get()
  const first = await operations.call('remember', memory)
  expect((await operations.call('remember', memory)).duplicate).toBe(true)
  await expect(operations.call('remember', { ...memory, text: 'Una corrección' })).rejects.toThrow('expected_updated_at')
  const entity = (await operations.call('get_entity', { id: first.entity_id })).entity
  const corrected = await operations.call('remember', { ...memory, text: 'Ejecutar pruebas y revisar la release.', expected_updated_at: entity.updated_at })
  expect(corrected.entity_id).toBe(first.entity_id); expect(corrected.version_id).not.toBe(first.version_id)
  expect(JSON.stringify(await store.original(first.version_id))).toContain(memory.text)
  const context = await operations.call('context', {})
  expect(context.memories[0].id).toBe(first.entity_id)
  expect(context.maintenance.due).toBe(true)
  expect(context.memory_capabilities).toMatchObject({ primary_memory: true, max_file_mb: 25 })
})
it('archiva sólo duplicados exactos y vencidos, conserva citas y permite restaurar fijando el recuerdo', async () => {
  const { operations, store, db } = await service.get()
  const project = await store.create({ kind: 'project', title: 'Otro ámbito' })
  const first = await operations.call('remember', memory)
  const duplicate = await operations.call('remember', { ...memory, key: 'tests-copy' })
  const other = await operations.call('remember', { ...memory, project_id: project.id })
  const expired = await operations.call('remember', { key: 'old', title: 'Dato temporal', text: 'Referencia temporal.', expires_at: '2000-01-01T00:00:00Z' })
  const original = await store.original(duplicate.version_id)
  const result = await tidyMemory(store, defaultAI, { reason: 'Prueba', actor: 'test' }, signal(), async () => {})
  expect(result).toMatchObject({ memories_archived: 2, memory_duplicates: 1 })
  expect((await operations.call('list_memories', {})).items.map((e: any) => e.id).sort()).toEqual([first.entity_id,other.entity_id].sort())
  expect((await operations.call('list_memories', { state: 'archived' })).total).toBe(2)
  expect(await store.original(duplicate.version_id)).toEqual(original)
  expect((await operations.call('search', { query: 'pruebas', mode: 'text' })).items.map((e: any) => e.entity_id)).not.toContain(duplicate.entity_id)
  expect((await operations.call('tidy_memory', {})).queued).toBe(false)
  const archived = (await operations.call('get_entity', { id: expired.entity_id })).entity
  await operations.call('manage_memory', { id: archived.id, action: 'restore', reason: 'Todavía hace falta', expected_updated_at: archived.updated_at })
  expect((await tidyMemory(store, defaultAI, { actor: 'test' }, signal(), async () => {})).memories_archived).toBe(0)
  expect((await db.query("SELECT action FROM changes WHERE entity_id=$1 AND action LIKE 'memory.%' ORDER BY id", [archived.id])).map(r => r.action)).toEqual(['memory.archive','memory.restore'])
})
it('deduplica pedidos al worker y no permite administrar documentos como recuerdos', async () => {
  const { operations, store } = await service.get()
  const source = await store.ingest({ kind: 'document', title: 'Original', text: 'Evidencia', external_id: 'original' })
  const entity = (await operations.call('get_entity', { id: source.entity_id })).entity
  await expect(operations.call('manage_memory', { id: entity.id, action: 'archive', reason: 'No es un recuerdo', expected_updated_at: entity.updated_at })).rejects.toThrow('sólo para recuerdos')
  const first = await operations.call('tidy_memory', {})
  expect(await operations.call('tidy_memory', {})).toMatchObject({ duplicate: true, job_id: first.job_id })
  const { runner } = await service.get()
  await runner.once(signal()); await runner.once(signal())
  expect((await operations.call('health', {})).last).toMatchObject({ stage: 'complete', memories_reviewed: 0 })
})
it('usa similitud sólo para proponer revisión, incluso ante afirmaciones contradictorias', async () => {
  const { operations, store, db } = await service.get()
  const first = await operations.call('remember', { key: 'current', title: 'Decisión vigente', text: 'Usamos PostgreSQL en producción.' })
  const second = await operations.call('remember', { key: 'old', title: 'Decisión anterior', text: 'No usamos PostgreSQL en producción.' })
  for (const saved of [first,second]) await db.query(`INSERT INTO entity_embeddings(entity_id,model,dimension,embedding,content_hash)
    SELECT id,'fixture',3,$2,md5(memory_entity_text(title,data)) FROM entities WHERE id=$1`, [saved.entity_id,vector([1,0,0])])
  const result = await tidyMemory(store, { ...defaultAI, embeddings_enabled: true, embedding_model: 'fixture' }, { actor: 'test' }, signal(), async () => {})
  expect(result.memories_archived).toBe(0)
  expect(result.related_memories).toHaveLength(1)
  expect((await operations.call('list_memories', {})).total).toBe(2)
})
