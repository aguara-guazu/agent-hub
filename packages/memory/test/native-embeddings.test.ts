import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMBEDDING_REPOSITORY, EMBEDDING_REVISION, embeddingInput, NATIVE_EMBEDDING_MODEL } from '../src/embedding-model.js'
import { NativeEmbeddings } from '../src/native-embeddings.js'
import { MemoryAI } from '../src/ai.js'
import { defaultAI, Vault } from '../src/config.js'

const workers = vi.hoisted(() => [] as any[])
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  terminated = false
  messages: any[] = []
  constructor(_url: URL, public options: any) { super(); workers.push(this) }
  postMessage(value: any) { this.messages.push(value); if (value.shutdown) queueMicrotask(() => this.emit('message', { type: 'stopped' })) }
  async terminate() { this.terminated = true; return 0 }
} }))
let directory: string, runtime: NativeEmbeddings
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function artifacts() {
  const root = join(runtime.cache, EMBEDDING_REPOSITORY, EMBEDDING_REVISION)
  mkdirSync(join(root, 'onnx'), { recursive: true })
  for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx', 'onnx/model_quantized.onnx_data']) writeFileSync(join(root, file), 'fixture')
}
async function install() {
  runtime.install(); await tick(); artifacts(); workers.at(-1).emit('message', { type: 'ready' }); await tick()
}
beforeEach(() => { workers.length = 0; directory = mkdtempSync(join(tmpdir(), 'native-embeddings-')); runtime = new NativeEmbeddings(directory) })
afterEach(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }) })
it('descarga sólo por acción explícita y no marca listo hasta completar la carga', async () => {
  expect(runtime.status().state).toBe('missing')
  await expect(runtime.embed(['test'], false)).rejects.toThrow('Descargá')
  expect(workers).toHaveLength(0)
  runtime.install(); runtime.install(); await tick()
  expect(workers).toHaveLength(1); expect(workers[0].options.workerData.install).toBe(true)
  workers[0].emit('message', { type: 'progress', progress: { file: 'model', loaded: 10, total: 100, progress: 10 } })
  expect(runtime.status()).toMatchObject({ state: 'downloading', percent: 10 })
  expect(runtime.installed()).toBe(false)
  artifacts(); workers[0].emit('message', { type: 'ready' }); await tick()
  expect(runtime.status().state).toBe('ready'); expect(workers[0].terminated).toBe(true)
  expect(workers[0].messages).toContainEqual({ shutdown: true })
  rmSync(join(runtime.cache, EMBEDDING_REPOSITORY, EMBEDDING_REVISION, 'tokenizer.json'))
  expect(runtime.installed()).toBe(false)
})
it('cancela la descarga, muestra el error y permite reintentar', async () => {
  runtime.install(); await tick(); await runtime.cancelInstall()
  expect(runtime.status()).toMatchObject({ state: 'error' }); expect(runtime.installed()).toBe(false)
  expect(workers[0].terminated).toBe(true)
  await install(); expect(runtime.installed()).toBe(true)
})
it('permite cerrar el Hub inmediatamente después de pedir una descarga', async () => {
  runtime.install()
  await runtime.close(); await tick()
  expect(workers).toHaveLength(0)
  expect(runtime.status().state).toBe('error')
})
it('separa consultas y documentos, usa el caché sin red y cancela la inferencia', async () => {
  await install()
  const fetcher = vi.fn(), vault = new Vault(directory)
  const ai = new MemoryAI(async () => ({ ...defaultAI, embeddings_enabled: true }), vault, fetcher, undefined, undefined, undefined, undefined, undefined, runtime)
  const query = ai.embedQuery('presupuesto'); await tick()
  const worker = workers.at(-1)
  expect(worker.options.workerData.install).toBe(false)
  worker.emit('message', { type: 'ready' }); await tick()
  expect(worker.messages[0]).toEqual({ texts: ['presupuesto'], query: true })
  worker.emit('message', { type: 'result', vectors: [Array(768).fill(0)] })
  expect((await query).model).toBe(NATIVE_EMBEDDING_MODEL)
  await ai.embedQuery('presupuesto'); expect(worker.messages).toHaveLength(1)
  const controller = new AbortController(), doc = runtime.embed(['Acta'], false, controller.signal)
  const rejection = expect(doc).rejects.toThrow('cancelada')
  await tick(); expect(worker.messages[1]).toEqual({ texts: ['Acta'], query: false })
  controller.abort(); await rejection
  expect(worker.terminated).toBe(true); expect(fetcher).not.toHaveBeenCalled()
  expect(worker.messages).not.toContainEqual({ shutdown: true })
  expect(embeddingInput('consulta', true)).toBe('task: search result | query: consulta')
  expect(embeddingInput('documento', false)).toBe('title: none | text: documento')
})

it('habilita reparar una instalación que ya no puede cargar sin descargar automáticamente', async () => {
  await install()
  const pending = runtime.embed(['prueba'], false)
  const rejected = expect(pending).rejects.toThrow('incompleto')
  await tick(); const worker = workers.at(-1)
  worker.emit('message', { type: 'error', error: 'El modelo local está incompleto' })
  await rejected; expect(runtime.status().state).toBe('error'); expect(runtime.installed()).toBe(false)
  expect(worker.options.workerData.install).toBe(false)
  await install(); expect(runtime.installed()).toBe(true)
})
