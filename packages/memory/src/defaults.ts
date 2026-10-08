import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { defaultAI, localUrl, type AIConfig } from './config.js'
import { findExtractionCli, isExtractionCli } from './cli-extraction.js'
import { findOpenCode } from './opencode.js'
import { NATIVE_EMBEDDING_MODEL } from './embedding-model.js'
import type { MemoryService } from './service.js'

export const EXTRACTION_PRIORITY = ['claude_code','codex_cli','opencode','kiro','ollama','deepseek'] as const
export function findOllama(env = process.env, home = homedir()) {
  for (const dir of [...(env.PATH ?? '').split(delimiter).filter(Boolean), join(home,'.local/bin'), '/opt/homebrew/bin','/usr/local/bin','/Applications/Ollama.app/Contents/Resources', ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA,'Programs','Ollama')] : [])]) {
    const path = join(dir, process.platform === 'win32' ? 'ollama.exe' : 'ollama')
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path } catch { /* optional */ }
  }
  return undefined
}
export function preferredExtraction(available = { claude_code: !!findExtractionCli('claude_code'), codex_cli: !!findExtractionCli('codex_cli'),
  opencode: !!findOpenCode(), kiro: !!findExtractionCli('kiro'), ollama: !!findOllama() }): AIConfig['extraction'] {
  return EXTRACTION_PRIORITY.find(p => p === 'deepseek' || available[p])!
}
type Setup = { target: string; embedding_state: 'pending'|'downloading'|'ready'|'paused'|'error'|'custom'; previous_ai: AIConfig | null; provider_state: 'pending'|'ready'|'needs_model'|'preserved'; error?: string; completed_at?: string }
export const DEFAULTS_KEY = 'ai_defaults'

/** Owned by the HTTP process, so downloads remain visible/cancellable in Settings. */
export class MemoryDefaults {
  private active: Promise<void> | undefined
  private stopped = false
  constructor(private service: MemoryService, private detect = preferredExtraction) {}
  tick() {
    if (this.stopped) return Promise.resolve()
    this.active ??= this.prepare().finally(() => { this.active = undefined })
    return this.active
  }
  stop() { this.stopped = true }
  async idle() { await this.active?.catch(() => {}) }
  async status() { return (await (await this.service.get()).db.query('SELECT value FROM settings WHERE key=$1', [DEFAULTS_KEY]))[0]?.value as Setup | undefined }
  async recommendProvider() {
    await this.tick()
    const { db } = await this.service.get(), provider = this.detect()
    const config = { ...await this.service.aiSettings(), extraction: provider, extraction_model: provider === 'deepseek' ? defaultAI.extraction_model : '', extraction_reasoning_effort: '', remote_processing_enabled: false }
    await db.transaction(async sql => {
      await sql.query("INSERT INTO settings(key,value) VALUES('ai',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(config)])
      await sql.query("UPDATE settings SET value=json_set(value,'$.provider_state','pending') WHERE key=$1", [DEFAULTS_KEY])
    })
    return config
  }
  async pause() { await this.state('paused'); return this.service.nativeEmbeddings.cancelInstall() }
  async resume() { await this.state('pending'); return this.service.nativeEmbeddings.install() }
  private async state(value: Setup['embedding_state']) {
    const { db } = await this.service.get()
    await db.query("UPDATE settings SET value=json_set(value,'$.embedding_state',$1) WHERE key=$2", [value, DEFAULTS_KEY])
  }
  private async prepare() {
    const { db, store } = await this.service.get(), native = this.service.nativeEmbeddings
    await db.transaction(async sql => {
      const setup = (await sql.query('SELECT value FROM settings WHERE key=$1', [DEFAULTS_KEY]))[0]?.value
      if (setup?.target === NATIVE_EMBEDDING_MODEL || this.stopped) return
      const previous = (await sql.query("SELECT value FROM settings WHERE key='ai'"))[0]?.value
      if (!previous) {
        const provider = this.detect()
        await sql.query("INSERT INTO settings(key,value) VALUES('ai',$1)", [JSON.stringify({ ...defaultAI, extraction: provider, extraction_model: provider === 'deepseek' ? defaultAI.extraction_model : '' })])
      }
      await sql.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [DEFAULTS_KEY, JSON.stringify({ target: NATIVE_EMBEDDING_MODEL,
        embedding_state: 'pending', previous_ai: previous ?? null, provider_state: previous ? 'preserved' : 'pending' } satisfies Setup)])
    })
    let setup = await this.status()
    if (!setup || this.stopped) return
    if (setup.embedding_state === 'pending' || setup.embedding_state === 'downloading') {
      const status = native.status()
      if (status.state === 'ready') {
        await db.transaction(async sql => {
          const current = (await sql.query('SELECT value FROM settings WHERE key=$1', [DEFAULTS_KEY]))[0]!.value as Setup
          if (this.stopped || !['pending','downloading'].includes(current.embedding_state)) return
          await sql.query("UPDATE settings SET value=json_set(value,'$.embedding_model',$1,'$.embeddings_enabled',json('true')) WHERE key='ai'", [NATIVE_EMBEDDING_MODEL])
          for (const row of await sql.query("SELECT current_version_id FROM sources WHERE status='active' AND current_version_id IS NOT NULL"))
            await store.enqueue('process', { version_id: row.current_version_id, index_only: true }, `native-migration:${NATIVE_EMBEDDING_MODEL}:${row.current_version_id}`, sql)
          await store.enqueue('index_entities', {}, `entity-index:${NATIVE_EMBEDDING_MODEL}`, sql)
          await sql.query('UPDATE settings SET value=$1 WHERE key=$2', [JSON.stringify({ ...current, embedding_state: 'ready', completed_at: new Date().toISOString() }), DEFAULTS_KEY])
        })
      } else if (status.state === 'error') {
        await db.query("UPDATE settings SET value=json_set(value,'$.embedding_state','error','$.error',$1) WHERE key=$2 AND value->>'embedding_state' IN ('pending','downloading')", [status.error ?? 'No se pudo descargar Gemma', DEFAULTS_KEY])
      } else if (status.state !== 'downloading') {
        native.install()
        await db.query("UPDATE settings SET value=json_set(value,'$.embedding_state','downloading') WHERE key=$1 AND value->>'embedding_state' IN ('pending','downloading')", [DEFAULTS_KEY])
      }
    }
    setup = await this.status()
    if (setup?.provider_state !== 'pending' || this.stopped) return
    const ai = await this.service.aiSettings()
    let model = '', detail = ''
    if (isExtractionCli(ai.extraction)) {
      const result = await this.service.cliExtraction.status(ai.extraction)
      model = result.models.find(m => m.default)?.id ?? result.models[0]?.id ?? ''; detail = result.detail ?? ''
    } else if (ai.extraction === 'opencode') {
      const result = await this.service.openCode.status(); model = result.models[0]?.id ?? ''; detail = result.detail ?? ''
    } else if (ai.extraction === 'ollama') {
      try {
        const response = await fetch(`${localUrl(ai.ollama_url)}/api/tags`, { signal: AbortSignal.timeout(3000) })
        const result = await response.json() as { models?: { name: string; details?: { family?: string } }[] }
        model = result.models?.find(m => !/embed|bert/i.test(`${m.name} ${m.details?.family ?? ''}`))?.name ?? ''
      } catch { detail = 'Iniciá Ollama y elegí un modelo de generación instalado.' }
    } else if (ai.extraction === 'deepseek') model = defaultAI.extraction_model
    if (this.stopped) return
    await db.transaction(async sql => {
      const current = (await sql.query("SELECT value FROM settings WHERE key='ai'"))[0]!.value
      // A manual save wins over slow model discovery.
      if (JSON.stringify(current) !== JSON.stringify(ai)) return
      await sql.query("UPDATE settings SET value=json_set(value,'$.extraction_model',$1) WHERE key='ai'", [model])
      await sql.query("UPDATE settings SET value=json_set(value,'$.provider_state',$1,'$.provider_detail',$2) WHERE key=$3", [model ? 'ready' : 'needs_model', detail, DEFAULTS_KEY])
    })
  }
}
