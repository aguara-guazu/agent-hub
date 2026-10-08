import { Worker } from 'node:worker_threads'
import { mkdirSync, readFileSync, renameSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { modelProfile, type InferenceProfile, type MediaEmbedding, type SpeechResult } from './media-models.js'
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
  constructor(directory: string, readonly profile: InferenceProfile = 'text') {
    this.cache = join(directory, 'memory', 'models', modelProfile(profile).id)
    this.marker = join(this.cache, profile === 'text' ? 'ready.json' : `ready-${profile}.json`)
  }
  installed() {
    try {
      const marker = JSON.parse(readFileSync(this.marker, 'utf8'))
      const model = modelProfile(this.profile)
      return marker.revision === model.revision && model.files.every(file => statSync(join(this.cache, model.repository, model.revision, file)).size > 0)
    } catch { return false }
  }
  status() { return { model: modelProfile(this.profile).id, state: this.installing ? 'downloading' : this.installed() ? 'ready' : this.error ? 'error' : 'missing',
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
        writeFileSync(`${this.marker}.tmp`, JSON.stringify({ revision: modelProfile(this.profile).revision }))
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
    const ready = this.wait(install ? 60 * 60_000 : 180_000)
    try {
      const touch = () => {
        clearTimeout(this.stalled)
        if (install) this.stalled = setTimeout(() => { void this.stop(new Error('La descarga no avanzó durante 90 segundos. Revisá la conexión y reintentá.')) }, 90_000)
      }
      touch()
      this.worker = new Worker(new URL('./embedding-worker.js', import.meta.url), { workerData: { cache: this.cache, install, profile: this.profile } })
      this.worker.on('message', message => {
        if (message.type === 'progress') {
          touch()
          const p = message.progress
          if (p.file) this.progress = { file: p.file, loaded: p.loaded, total: p.total, percent: p.progress }
          return
        }
        if (message.type === 'validating') { clearTimeout(this.stalled); this.progress = { file: 'Comprobando el módulo local…' }; return }
        if (message.type === 'error') { void this.stop(new Error(message.error)); return }
        if (message.type === 'ready') { this.loaded = true; clearTimeout(this.stalled) }
        if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve(message.result ?? message.vectors); this.pending = undefined }
      })
      this.worker.on('error', error => { void this.stop(error) })
      this.worker.on('exit', code => { if (this.pending) void this.stop(new Error(`El motor de embeddings se cerró (${code})`)) })
    } catch (error) { await this.stop(error as Error) }
    await ready
  }
  private async request(payload: object, signal?: AbortSignal): Promise<any> {
    return this.exclusive(async () => {
      signal?.throwIfAborted()
      if (!this.installed()) throw new MemoryError(409, 'Descargá el módulo local desde Memoria → Fuentes y ajustes')
      clearTimeout(this.idle)
      const abort = () => { void this.stop(new Error('Generación de embeddings cancelada')) }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        try { await this.start() } catch (error) {
          if (!signal?.aborted) { rmSync(this.marker, { force: true }); this.error = error instanceof Error ? error.message : 'No se pudo cargar el módulo. Reintentá su descarga.' }
          throw error
        }
        signal?.throwIfAborted()
        const result = this.wait(this.profile === 'speech' ? 10 * 60_000 : 180_000)
        this.worker!.postMessage(payload)
        return await result
      } finally {
        signal?.removeEventListener('abort', abort)
        this.idle = setTimeout(() => { void this.stop() }, 60_000)
        this.idle.unref()
      }
    })
  }
  async embed(texts: string[], query: boolean, signal?: AbortSignal): Promise<number[][]> {
    const vectors = await this.request({ texts, query }, signal) as number[][]
    if (vectors.length !== texts.length || vectors.some(v => v.length !== 768 || !v.every(Number.isFinite))) throw new Error('EmbeddingGemma 2 devolvió vectores inválidos')
    return vectors
  }
  async embedMedia(media: MediaEmbedding, signal: AbortSignal): Promise<number[]> {
    const vectors = await this.request({ media }, signal) as number[][]
    const vector = vectors[0]
    if (vectors.length !== 1 || !vector || vector.length !== 768 || !vector.every(Number.isFinite)) throw new Error('Embedding multimedia inválido')
    return vector
  }
  transcribe(audio: Float32Array, signal: AbortSignal, language = 'es'): Promise<SpeechResult> { return this.request({ audio, language }, signal) }
  async unload() { await this.queue; await this.stop() }
  private async stop(error = new Error('El motor de embeddings se cerró')) {
    clearTimeout(this.idle)
    clearTimeout(this.stalled)
    const worker = this.worker; this.worker = undefined; this.loaded = false
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined }
    if (worker) { worker.removeAllListeners(); await worker.terminate() }
  }
  async close() { this.closed = true; await this.stop(); await this.queue }
}
