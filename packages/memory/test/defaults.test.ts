import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryService } from '../src/service.js'
import { MemoryDefaults, preferredExtraction } from '../src/defaults.js'
import { defaultAI } from '../src/config.js'
import { NATIVE_EMBEDDING_MODEL } from '../src/embedding-model.js'
let directory: string, service: MemoryService, defaults: MemoryDefaults, state: 'missing'|'downloading'|'ready'|'error'
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'memory-defaults-')); service = new MemoryService(directory, 'http://localhost/callback')
  defaults = new MemoryDefaults(service, () => 'claude_code'); state = 'missing'
  vi.spyOn(service.nativeEmbeddings, 'status').mockImplementation(() => ({ model: NATIVE_EMBEDDING_MODEL, state, error: state === 'error' ? 'offline' : undefined }))
  vi.spyOn(service.nativeEmbeddings, 'install').mockImplementation(() => { state = 'downloading'; return service.nativeEmbeddings.status() })
  vi.spyOn(service.nativeEmbeddings, 'installed').mockImplementation(() => state === 'ready')
  vi.spyOn(service.cliExtraction, 'status').mockResolvedValue({ installed: true, models: [{ id: 'secondary', name: 'Secondary', reasoning_efforts: [] },{ id: 'account-default', default: true, name: 'Default', reasoning_efforts: [] }] })
})
afterEach(async () => { defaults.stop(); await defaults.idle(); await service.close(); await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks() })
it('respeta el orden de harness instalados y usa DeepSeek sólo si no hay ninguno', () => {
  const available = { claude_code: true, codex_cli: true, opencode: true, kiro: true, ollama: true }
  for (const provider of ['claude_code','codex_cli','opencode','kiro','ollama'] as const) { expect(preferredExtraction(available)).toBe(provider); available[provider] = false }
  expect(preferredExtraction(available)).toBe('deepseek')
})
it('descarga al iniciar, elige el modelo predeterminado de la CLI y habilita el índice sólo al estar listo', async () => {
  await defaults.tick()
  expect(service.nativeEmbeddings.install).toHaveBeenCalledTimes(1)
  expect(await service.aiSettings()).toMatchObject({ extraction: 'claude_code', extraction_model: 'account-default', embeddings_enabled: false, remote_processing_enabled: false })
  state = 'ready'; await defaults.tick()
  expect(await service.aiSettings()).toMatchObject({ embedding_model: NATIVE_EMBEDDING_MODEL, embeddings_enabled: true })
  await defaults.tick(); expect(service.cliExtraction.status).toHaveBeenCalledTimes(1)
  expect((await defaults.status())?.embedding_state).toBe('ready')
})
it('migra embeddings legacy después de descargar, conserva el proveedor y no repite extracción remota', async () => {
  const { db, store } = await service.get(), previous = { ...defaultAI, extraction: 'deepseek', remote_processing_enabled: true, embedding_model: 'nomic-embed-text', embeddings_enabled: true }
  await db.query("INSERT INTO settings(key,value) VALUES('ai',$1)", [JSON.stringify(previous)])
  const source = await store.ingest({ kind: 'document', title: 'Documento', external_id: 'doc', fragments: [{ text: 'Evidencia', metadata: {} }], metadata: {}, original: { text: 'Evidencia' }, project_ids: [] }, 'test')
  await defaults.tick(); expect(await service.aiSettings()).toEqual(previous)
  state = 'ready'; await defaults.tick()
  expect(await service.aiSettings()).toEqual({ ...previous, embedding_model: NATIVE_EMBEDDING_MODEL })
  const job = (await db.query("SELECT payload FROM jobs WHERE dedupe_key=$1", [`native-migration:${NATIVE_EMBEDDING_MODEL}:${source.version_id}`]))[0]!
  expect(job.payload.index_only).toBe(true); expect(service.cliExtraction.status).not.toHaveBeenCalled()
  expect((await defaults.status())?.previous_ai).toEqual(previous)
})
it('no reinicia cancelaciones o fallos y conserva una elección manual posterior', async () => {
  await defaults.tick(); await defaults.pause(); state = 'missing'; await defaults.tick()
  expect(service.nativeEmbeddings.install).toHaveBeenCalledTimes(1)
  await defaults.resume(); state = 'error'; await defaults.tick(); await defaults.tick()
  expect((await defaults.status())?.embedding_state).toBe('error'); expect(service.nativeEmbeddings.install).toHaveBeenCalledTimes(2)
  await service.saveAI({ ...await service.aiSettings(), embedding_model: 'custom-local', embeddings_enabled: false })
  state = 'ready'; await defaults.tick()
  expect((await service.aiSettings()).embedding_model).toBe('custom-local')
  expect((await defaults.status())?.embedding_state).toBe('custom')
})
it('una elección manual gana frente a una consulta lenta de modelos', async () => {
  let resolve!: (value: any) => void, started!: () => void
  const ready = new Promise<void>(r => { started = r })
  vi.mocked(service.cliExtraction.status).mockImplementation(() => { started(); return new Promise(r => { resolve = r }) })
  const preparing = defaults.tick(); await ready
  await service.saveAI({ ...await service.aiSettings(), extraction: 'disabled', extraction_model: '' })
  resolve({ installed: true, models: [{ id: 'late', name: 'Late' }] }); await preparing
  expect(await service.aiSettings()).toMatchObject({ extraction: 'disabled', extraction_model: '' })
  expect((await defaults.status())?.provider_state).toBe('preserved')
})
it('permite adoptar el proveedor recomendado sin heredar permisos o modelos de otra cuenta', async () => {
  const { db } = await service.get()
  await db.query("INSERT INTO settings(key,value) VALUES('ai',$1)", [JSON.stringify({ ...defaultAI, remote_processing_enabled: true })])
  expect(await defaults.recommendProvider()).toMatchObject({ extraction: 'claude_code', extraction_model: '', extraction_reasoning_effort: '', remote_processing_enabled: false })
  await defaults.tick()
  expect((await service.aiSettings()).extraction_model).toBe('account-default')
})
