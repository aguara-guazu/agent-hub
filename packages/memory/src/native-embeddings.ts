import { Worker } from 'node:worker_threads'
import { mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { EMBEDDING_REPOSITORY, EMBEDDING_REVISION, NATIVE_EMBEDDING_MODEL } from './embedding-model.js'
import { MemoryError } from './contracts.js'

export class NativeEmbeddings {
  private worker: Worker | undefined
  private idle?: NodeJS.Timeout
  private pending: { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private installing = false
  private installCancelled = false
  private loaded = false
  private closed = false
  private stalled: NodeJS.Timeout | undefined
  private error: string | undefined
  private progress: { file?: string; loaded?: number; total?: number; percent?: number } = {}
  readonly cache: string
  private readonly marker: string
  constructor(directory: string) {
    this.cache = join(directory, 'memory', 'models', NATIVE_EMBEDDING_MODEL)
    this.marker = join(this.cache, 'ready.json')
  }
  installed() {
    try {
      const marker = JSON.parse(readFileSync(this.marker, 'utf8'))
      return marker.revision === EMBEDDING_REVISION && ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx', 'onnx/model_quantized.onnx_data']
        .every(file => statSync(join(this.cache, EMBEDDING_REPOSITORY, EMBEDDING_REVISION, file)).size > 0)
    } catch { return false }
  }
  status() { return { model: NATIVE_EMBEDDING_MODEL, state: this.installing ? 'downloading' : this.installed() ? 'ready' : this.error ? 'error' : 'missing',
    ...this.progress, error: this.error } }
  install() {
    if (this.closed) throw new MemoryError(503, 'El motor de embeddings está cerrado')
    if (this.installing || this.installed()) return this.status()
    this.installing = true; this.installCancelled = false; this.error = undefined; this.progress = {}
    void this.exclusive(async () => {
      try {
        if (this.installCancelled) throw new Error('Descarga cancelada. Podés reintentar.')
        await this.start(true)
        mkdirSync(this.cache, { recursive: true })
        writeFileSync(`${this.marker}.tmp`, JSON.stringify({ revision: EMBEDDING_REVISION }))
        renameSync(`${this.marker}.tmp`, this.marker)
      } catch (error) { this.error = error instanceof Error ? error.message : 'Falló la descarga del modelo' }
      finally { this.installing = false; await this.stop() }
    }).catch(error => { this.installing = false; this.error = error instanceof Error ? error.message : 'Falló la descarga del modelo' })
    return this.status()
  }
  async cancelInstall() { if (this.installing) { this.installCancelled = true; this.error = 'Descarga cancelada. Podés reintentar.'; await this.stop(new Error(this.error)); await this.queue }; return this.status() }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => { if (this.closed) throw new MemoryError(503, 'El motor de embeddings está cerrado'); return action() })
    this.queue = next.catch(() => undefined)
    return next
  }
  private wait(timeout: number): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, timer: setTimeout(() => { void this.stop(new Error('EmbeddingGemma 2 no respondió a tiempo. Reintentá desde Ajustes.')) }, timeout) }
    })
  }
  private async start(install = false) {
    if (this.loaded) return
    const ready = this.wait(install ? 20 * 60_000 : 120_000)
    try {
      const touch = () => {
        clearTimeout(this.stalled)
        if (install) this.stalled = setTimeout(() => { void this.stop(new Error('La descarga no avanzó durante 90 segundos. Revisá la conexión y reintentá.')) }, 90_000)
      }
      touch()
      this.worker = new Worker(new URL('./embedding-worker.js', import.meta.url), { workerData: { cache: this.cache, install } })
      this.worker.on('message', message => {
        if (message.type === 'progress') {
          touch()
          const p = message.progress
          if (p.file) this.progress = { file: p.file, loaded: p.loaded, total: p.total, percent: p.progress }
          return
        }
        if (message.type === 'error') { void this.stop(new Error(message.error)); return }
        if (message.type === 'ready') { this.loaded = true; clearTimeout(this.stalled) }
        if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve(message.vectors); this.pending = undefined }
      })
      this.worker.on('error', error => { void this.stop(error) })
      this.worker.on('exit', code => { if (this.pending) void this.stop(new Error(`El motor de embeddings se cerró (${code})`)) })
    } catch (error) { await this.stop(error as Error) }
    await ready
  }
  async embed(texts: string[], query: boolean, signal?: AbortSignal): Promise<number[][]> {
    return this.exclusive(async () => {
      signal?.throwIfAborted()
      if (!this.installed()) throw new MemoryError(409, 'Descargá EmbeddingGemma 2 desde Memoria → Fuentes y ajustes')
      clearTimeout(this.idle)
      const abort = () => { void this.stop(new Error('Generación de embeddings cancelada')) }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        await this.start()
        signal?.throwIfAborted()
        const result = this.wait(120_000)
        this.worker!.postMessage({ texts, query })
        const vectors = await result as number[][]
        if (vectors.length !== texts.length || vectors.some(v => v.length !== 768 || !v.every(Number.isFinite))) throw new Error('EmbeddingGemma 2 devolvió vectores inválidos')
        return vectors
      } finally {
        signal?.removeEventListener('abort', abort)
        this.idle = setTimeout(() => { void this.stop() }, 60_000)
        this.idle.unref()
      }
    })
  }
  private async stop(error = new Error('El motor de embeddings se cerró')) {
    clearTimeout(this.idle)
    clearTimeout(this.stalled)
    const worker = this.worker; this.worker = undefined; this.loaded = false
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined }
    if (worker) { worker.removeAllListeners(); await worker.terminate() }
  }
  async close() { this.closed = true; await this.stop(); await this.queue }
}
