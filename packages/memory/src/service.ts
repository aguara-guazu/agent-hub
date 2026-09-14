import { z } from 'zod'
import { MemoryDatabase } from './database.js'
import { Vault, defaultAI, localUrl, type AIConfig } from './config.js'
import { MemoryStore } from './store.js'
import { MemoryOperations } from './operations.js'
import { MemoryAI } from './ai.js'
import { GoogleAuth } from './google-auth.js'
import { JobRunner } from './jobs.js'
import { check, MemoryError, parse } from './contracts.js'

export const aiConfigSchema = z.object({ extraction: z.enum(['disabled','deepseek','ollama']), extraction_model: z.string().min(1).max(200),
  embeddings_enabled: z.boolean(), embedding_model: z.string().min(1).max(200), ollama_url: z.url(), remote_processing_enabled: z.boolean(),
  identity_auto_merge: z.boolean().default(true) }).strict()
export class MemoryService {
  readonly vault: Vault
  readonly google: GoogleAuth
  private current: { db: MemoryDatabase; store: MemoryStore; ai: MemoryAI; operations: MemoryOperations; runner: JobRunner } | null = null
  private initializing: Promise<NonNullable<MemoryService['current']>> | null = null
  constructor(readonly directory: string, redirectUrl: string, private fetcher: typeof fetch = fetch) {
    this.vault = new Vault(directory)
    this.google = new GoogleAuth(this.vault, redirectUrl, fetcher)
  }
  async get() {
    if (this.current) return this.current
    this.initializing ??= this.initialize().finally(() => { this.initializing = null })
    return this.initializing
  }
  private async initialize() {
    const url = process.env.AGENTHUB_MEMORY_DATABASE_URL || this.vault.read('database')?.url
    if (!url) throw new MemoryError(503, 'Prepará PostgreSQL desde Ajustes de memoria o con npm run memory:up')
    const db = new MemoryDatabase(url)
    try { await db.migrate() } catch {
      await db.close().catch(() => undefined)
      throw new MemoryError(503, 'No se pudo conectar con PostgreSQL y pgvector. Revisá que el servicio local esté iniciado')
    }
    const store = new MemoryStore(db, this.directory)
    const ai = new MemoryAI(() => this.aiSettings(), this.vault, this.fetcher)
    const operations = new MemoryOperations(store, ai)
    const runner = new JobRunner(store, ai, this.vault, this.google, () => this.aiSettings(), this.fetcher)
    this.current = { db, store, ai, operations, runner }
    return this.current
  }
  async status() {
    const configuration = { database_configured: Boolean(process.env.AGENTHUB_MEMORY_DATABASE_URL || this.vault.has('database')),
      google_client_configured: this.vault.has('google-client'), deepseek_configured: this.vault.has('deepseek'), google_redirect_url: this.google.redirectUrl }
    try {
      const { db } = await this.get()
      const counts = await db.query('SELECT kind,count(*)::int AS count FROM entities GROUP BY kind')
      const worker = (await db.query("SELECT value FROM settings WHERE key='worker'"))[0]?.value ?? null
      const [sources] = await db.query('SELECT count(*)::int AS count,max(synced_at) AS last_import FROM sources')
      const [pending] = await db.query("SELECT count(*)::int AS count FROM jobs WHERE state IN ('queued','running','waiting')")
      return { ready: true, ...configuration, counts: Object.fromEntries(counts.map(r => [r.kind, r.count])), sources, pending_jobs: pending?.count ?? 0,
        worker, ai: await this.aiSettings() }
    } catch (error) {
      return { ready: false, ...configuration, counts: {}, pending_jobs: 0, ai: defaultAI,
        detail: error instanceof MemoryError ? error.message : 'La memoria local no está disponible' }
    }
  }
  async aiSettings(): Promise<AIConfig> {
    const { db } = await this.get()
    const row = (await db.query("SELECT value FROM settings WHERE key='ai'"))[0]
    return { ...defaultAI, ...row?.value }
  }
  async saveAI(raw: unknown) {
    const config = parse(aiConfigSchema, raw)
    localUrl(config.ollama_url)
    check(new URL(config.ollama_url).protocol === 'http:' || new URL(config.ollama_url).protocol === 'https:', 'URL de Ollama inválida')
    const { db } = await this.get()
    await db.query("INSERT INTO settings(key,value) VALUES('ai',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(config)])
    return config
  }
  async close() { const current = this.current; this.current = null; if (current) await current.db.close() }
  async saveDatabase(url: string) {
    const parsed = new URL(url)
    check(['postgres:', 'postgresql:'].includes(parsed.protocol), 'Se requiere una URL de PostgreSQL')
    localUrl(url)
    const probe = new MemoryDatabase(url)
    try { await probe.migrate() } catch { throw new MemoryError(503, 'No se pudo conectar con esa base local o instalar pgvector') }
    finally { await probe.close() }
    this.vault.save('database', { url })
    await this.close()
    return { configured: true }
  }
}
