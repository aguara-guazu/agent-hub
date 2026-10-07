import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryService } from '../src/service.js'
import { importFile, readFileAttachment } from '../src/attachments.js'
import { exportMemory, readBackup, restoreMemory, deleteEntity } from '../src/backup.js'
import { defaultAI } from '../src/config.js'
import { NATIVE_EMBEDDING_MODEL } from '../src/embedding-model.js'

let service: MemoryService, directory: string
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv1sAAAAASUVORK5CYII=', 'base64')
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'memory-files-')); service = new MemoryService(directory, 'http://localhost/callback') })
afterEach(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })
it('conserva bytes, contexto, timestamps y versiones distintas aunque la descripción no cambie', async () => {
  const { store, operations } = await service.get(), path = join(directory, 'captura.png')
  await writeFile(path, png)
  const input = { path, title: 'Falla al guardar', description: 'Captura de la pantalla de pagos', external_id: 'capture:payments',
    annotations: [{ text: 'Aparece el mensaje de error', offset_ms: 12500, end_offset_ms: 16000, region: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 } }] }
  const first = await operations.call('import_file', input)
  expect(first.attachment).toMatchObject({ mime_type: 'image/png', size: png.length })
  expect((await readFileAttachment(store, first.version_id)).data).toEqual(png)
  expect((await operations.call('get_entity', { id: first.entity_id })).entity.data.remote_processing).toBe(false)
  const found = await operations.call('search', { query: 'mensaje', mode: 'text' })
  expect(found.items[0]).toMatchObject({ attachment: { download_url: `/api/memory/files/${first.version_id}` }, media_position: { offset_ms: 12500, end_offset_ms: 16000 } })
  expect(await operations.call('get_file', { version_id: first.version_id, include_content: true })).toMatchObject({ data_base64: png.toString('base64') })
  expect((await operations.call('import_file', input)).duplicate).toBe(true)
  await writeFile(path, Buffer.concat([png, Buffer.from('new bytes')]))
  const second = await operations.call('import_file', input)
  expect(second.entity_id).toBe(first.entity_id); expect(second.version_id).not.toBe(first.version_id)
  expect((await readFileAttachment(store, first.version_id)).data).toEqual(png)
})
it('incluye los archivos en el respaldo y los elimina con la entidad', async () => {
  const { store } = await service.get()
  const saved = await importFile(store, { filename: 'evidencia.bin', data_base64: png.toString('base64'), title: 'Captura' }, 'test')
  const backup = JSON.parse(await readBackup(store, (await exportMemory(store)).id))
  const restored = new MemoryService(join(directory, 'restore'), 'http://localhost/callback')
  try {
    const other = (await restored.get()).store
    await restoreMemory(other, backup)
    expect((await readFileAttachment(other, saved.version_id)).data).toEqual(png)
    const result = await deleteEntity(other, saved.entity_id)
    expect(result.original_files).toHaveLength(1)
    await expect(readFile(join(other.directory, 'originals', result.original_files[0]!))).rejects.toThrow()
  } finally { await restored.close() }
})
it('indexa el contenido UTF-8 de archivos de texto y conserva el original exacto', async () => {
  const { operations } = await service.get()
  const content = '# Procedimiento\n\nLa restauración usa el respaldo aurora.\n'
  const saved = await operations.call('import_file', { filename: 'procedimiento.md', title: 'Archivo adjunto', data_base64: Buffer.from(content).toString('base64') })
  expect(saved.attachment.mime_type).toBe('text/plain')
  const found = await operations.call('search', { query: 'aurora', mode: 'text' })
  expect(found.items[0]).toMatchObject({ entity_id: saved.entity_id })
  const file = await operations.call('get_file', { version_id: saved.version_id, include_content: true })
  expect(Buffer.from(file.data_base64, 'base64').toString('utf8')).toBe(content)
})
it('rechaza rutas relativas, directorios, base64 inválido y marcas de tiempo invertidas', async () => {
  const { store } = await service.get()
  for (const input of [{ path: 'relative.png' }, { path: directory }, { filename: '../escape.png', data_base64: 'aGVsbG8=' },
    { filename: 'x', data_base64: 'a===' }, { path: directory, data_base64: 'aGVsbG8=' },
    { filename: 'x', data_base64: 'aGVsbG8=', annotations: [{ text: 'x', offset_ms: 500, end_offset_ms: 100 }] }]) {
    await expect(importFile(store, { title: 'Prueba', ...input }, 'test')).rejects.toThrow()
  }
  expect(await store.db.query('SELECT id FROM sources')).toHaveLength(0)
})
it('regenera sólo los embeddings sin cambiar originales ni pedir extracción remota', async () => {
  const { operations, store, db } = await service.get()
  await expect(operations.call('rebuild_embeddings', {})).rejects.toThrow('Habilitá')
  await service.saveAI({ ...defaultAI, embedding_model: 'old-ollama-model', embeddings_enabled: true })
  const source = await store.ingest({ kind: 'document', external_id: 'example', title: 'Ejemplo', text: 'Datos conservados' })
  const before = await store.original(source.version_id)
  expect(await operations.call('rebuild_embeddings', {})).toMatchObject({ queued: 2, model: 'old-ollama-model' })
  const jobs = await db.query("SELECT payload FROM jobs WHERE dedupe_key LIKE 'rebuild-embeddings:%'")
  expect(jobs[0]!.payload).toEqual({ version_id: source.version_id, index_only: true, force: true })
  expect(await store.original(source.version_id)).toEqual(before)
  await expect(service.saveAI({ ...defaultAI, embedding_model: NATIVE_EMBEDDING_MODEL, embeddings_enabled: true })).rejects.toThrow('Descargá')
  expect((await service.aiSettings()).embedding_model).toBe('old-ollama-model')
})
