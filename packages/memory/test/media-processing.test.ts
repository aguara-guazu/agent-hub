import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryService } from '../src/service.js'
import { processMedia, queueMedia } from '../src/media-processing.js'
import { mediaSettingsInput, type MediaRuntime } from '../src/media-runtime.js'
import { readFileAttachment } from '../src/attachments.js'
import { NATIVE_EMBEDDING_MODEL } from '../src/embedding-model.js'
import { processVersion } from '../src/processing.js'
import { defaultAI } from '../src/config.js'

let directory: string, service: MemoryService
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv1sAAAAASUVORK5CYII=', 'base64')
const settings = mediaSettingsInput.parse({ ocr: true, vision: true })
const signal = () => new AbortController().signal
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'media-processing-test-')); service = new MemoryService(directory, 'http://localhost/callback') })
afterEach(async () => { await service.close(); await rm(directory, { force: true, recursive: true }) })
async function fixture() {
  const { store, operations } = await service.get()
  await store.db.query("INSERT INTO settings(key,value) VALUES('media',$1)", [JSON.stringify(settings)])
  const saved = await operations.call('import_file', { title: 'Captura', filename: 'captura.png', data_base64: png.toString('base64'), description: 'Anotación original' })
  await queueMedia(store, { version_id: saved.version_id })
  const job = (await store.db.query("SELECT * FROM jobs WHERE kind='media'"))[0]!
  return { store, operations, saved, job }
}
const embedding = [1, ...Array(767).fill(0)]
function runtime(process = vi.fn(async () => ({ parts: [
  { text: 'Factura aurora', metadata: { generated: 'ocr', processor: 'fixture', confidence: 0.9 } },
  { text: 'Contenido visual', metadata: { generated: 'media', media_embedding: true, modality: 'image' }, vector: embedding },
], warnings: [] }))) { return { validate: () => settings, process } as unknown as MediaRuntime }
it('conserva originales y citas en una nueva versión; indexa OCR y el vector visual en el espacio nativo', async () => {
  const { store, operations, saved, job } = await fixture()
  const before = await store.original(saved.version_id)
  const result = await processMedia(store, runtime(), job.payload, signal(), async () => {})
  expect(result).toMatchObject({ generated_parts: 2, ocr_parts: 1, media_embeddings: 1 })
  expect(result.version_id).not.toBe(saved.version_id)
  expect(await store.original(saved.version_id)).toEqual(before)
  expect((await readFileAttachment(store, result.version_id!)).data).toEqual(png)
  expect((await operations.call('search', { query: 'aurora', mode: 'text' })).items[0]).toMatchObject({ entity_id: saved.entity_id, version_id: result.version_id })
  const fragments = await store.db.query('SELECT id,metadata FROM fragments WHERE version_id=$1', [result.version_id])
  const visual = fragments.find(f => f.metadata.media_embedding)!
  expect((await store.db.query('SELECT model,dimension FROM embeddings WHERE fragment_id=$1', [visual.id]))[0]).toEqual({ model: NATIVE_EMBEDDING_MODEL, dimension: 768 })
  // Regenerating the text index must never overwrite a visual vector with the placeholder's text embedding.
  const { ai } = await service.get(), embed = vi.spyOn(ai, 'embed').mockImplementation(async texts => ({ model: NATIVE_EMBEDDING_MODEL, vectors: texts.map(() => embedding) }))
  await processVersion(store, ai, result.version_id!, { ...defaultAI, extraction: 'disabled', embeddings_enabled: true }, async () => {}, signal(), true)
  expect(embed.mock.calls.flatMap(([texts]) => texts)).not.toContain('Contenido visual')
  expect(await queueMedia(store, {}, true)).toEqual({ queued: 0 })
})
it('descarta resultados si el archivo cambia durante el análisis', async () => {
  const { store, operations, saved, job } = await fixture()
  const newer = async () => {
    await operations.call('import_file', { title: 'Captura', filename: 'captura.png', data_base64: png.toString('base64'), description: 'Corrección del usuario' })
    return { parts: [], warnings: [] }
  }
  await expect(processMedia(store, runtime(vi.fn(newer)), job.payload, signal(), async () => {})).rejects.toThrow('cambió')
  expect(await store.original(saved.version_id)).toBeDefined()
  expect((await store.db.query('SELECT count(*) AS n FROM versions'))[0]!.n).toBe(2)
})
it('no reintenta automáticamente un análisis cancelado y no ejecuta una configuración que se desactivó', async () => {
  const { store, job } = await fixture()
  await store.db.query("UPDATE jobs SET state='cancelled' WHERE id=$1", [job.id])
  expect(await queueMedia(store, {}, true)).toEqual({ queued: 0 })
  await store.db.query("UPDATE settings SET value=$1 WHERE key='media'", [JSON.stringify(mediaSettingsInput.parse({}))])
  const engine = runtime()
  expect(await processMedia(store, engine, job.payload, signal(), async () => {})).toEqual({ skipped: 'settings_changed' })
  expect(engine.process).not.toHaveBeenCalled()
})

it('no persiste un análisis cancelado y la regeneración incluye los vectores audiovisuales', async () => {
  const { store, operations, job } = await fixture()
  const controller = new AbortController()
  const engine = runtime(vi.fn(async () => { controller.abort(); return { parts: [], warnings: [] } }))
  await expect(processMedia(store, engine, job.payload, controller.signal, async () => {})).rejects.toThrow()
  expect((await store.db.query('SELECT count(*) AS n FROM versions'))[0]!.n).toBe(1)
  await store.db.query("INSERT INTO settings(key,value) VALUES('ai',$1)", [JSON.stringify({ ...defaultAI, embeddings_enabled: true })])
  const rebuilt = await operations.call('rebuild_embeddings', {})
  expect(rebuilt.media_queued).toBe(1)
})
