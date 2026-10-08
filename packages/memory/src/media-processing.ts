import { z } from 'zod'
import { id, check, parse, importInput } from './contracts.js'
import { hash, type MemoryStore } from './store.js'
import { readFileAttachment } from './attachments.js'
import { MediaRuntime, mediaSettingsInput, MEDIA_REVISION, type MediaSettings } from './media-runtime.js'
import { vector } from './database.js'
import { NATIVE_EMBEDDING_MODEL } from './embedding-model.js'

export const processFilesInput = z.object({ version_id: id.optional(), force: z.boolean().default(false) }).strict()
export async function mediaSettings(store: MemoryStore): Promise<MediaSettings> {
  return parse(mediaSettingsInput, (await store.db.query("SELECT value FROM settings WHERE key='media'"))[0]?.value ?? {})
}
function processingKey(settings: MediaSettings) { const { automatic: _automatic, ...features } = settings; return hash({ revision: MEDIA_REVISION, ...features }) }
function applicable(mime: string, settings: MediaSettings) {
  return mime.startsWith('image/') ? settings.ocr || settings.vision
    : mime.startsWith('audio/') ? settings.transcription || settings.audio
      : mime.startsWith('video/') && (settings.ocr || settings.vision || settings.transcription || settings.audio)
}
export async function queueMedia(store: MemoryStore, raw: unknown, automatic = false) {
  const input = parse(processFilesInput, raw), settings = await mediaSettings(store)
  if (automatic && !settings.automatic) return { queued: 0 }
  check(automatic || settings.ocr || settings.transcription || settings.vision || settings.audio, 'Activá el procesamiento multimedia desde Memoria → Fuentes y ajustes', 409)
  const key = processingKey(settings)
  const sources = await store.db.query(`SELECT s.current_version_id,v.metadata FROM sources s JOIN versions v ON v.id=s.current_version_id
    WHERE s.status='active' AND v.metadata->'attachment' IS NOT NULL AND ($1 IS NULL OR v.id=$1)`, [input.version_id ?? null])
  if (input.version_id) check(sources.length, 'El archivo ya no es la versión vigente', 409)
  let queued = 0
  for (const row of sources) {
    if (!applicable(row.metadata.attachment.mime_type, settings)) continue
    if (!input.force && row.metadata.media_processing?.key === key) continue
    const dedupe = `media:${row.current_version_id}:${key}`
    // Failed and cancelled jobs stay visible; an automatic scan never silently restarts them.
    if (automatic && (await store.db.query("SELECT 1 FROM jobs WHERE dedupe_key=$1 AND state<>'completed' LIMIT 1", [dedupe])).length) continue
    await store.enqueue('media', { version_id: row.current_version_id, key, settings, force: input.force }, dedupe)
    queued++
  }
  if (input.version_id) check(queued || sources[0]!.metadata.media_processing?.key === key, 'Ningún módulo activo admite este formato', 409)
  return { queued }
}
export async function processMedia(store: MemoryStore, runtime: MediaRuntime, payload: any, signal: AbortSignal,
  progress: (value: Record<string, unknown>) => Promise<void>) {
  const source = (await store.db.query(`SELECT s.*,e.title,e.data FROM sources s JOIN entities e ON e.id=s.entity_id
    WHERE s.current_version_id=$1 AND s.status='active'`, [payload.version_id]))[0]
  if (!source) return { skipped: 'historical_version' }
  if (processingKey(await mediaSettings(store)) !== payload.key) return { skipped: 'settings_changed' }
  const settings = runtime.validate(payload.settings)
  const original = parse(importInput, await store.original(payload.version_id))
  if (!payload.force && (original.metadata.media_processing as any)?.key === payload.key) return { skipped: 'already_processed' }
  await progress({ source_title: source.title, entity_id: source.entity_id, version_id: payload.version_id, provider: 'local', stage: 'preparing' })
  const file = await readFileAttachment(store, payload.version_id)
  const result = await runtime.process(file, settings, signal, progress)
  signal.throwIfAborted()
  const inherited = await store.db.query("SELECT to_id FROM links WHERE from_id=$1 AND type='project'", [source.entity_id])
  const base = original.fragments.filter((f: any) => !f.metadata?.generated)
  // Each analysis is a new immutable version. Previous OCR, timestamps and citations remain retrievable.
  const parts = result.parts.map(({ text, offset_ms, metadata }, index) => ({ text, ...(offset_ms === undefined ? {} : { offset_ms }),
    metadata: { ...metadata, attachment: original.metadata.attachment, annotation: false, analysis_key: payload.key, analysis_part: index, review_state: 'pending' } }))
  return store.db.withOriginals(() => store.db.transaction(async sql => {
    const current = (await sql.query('SELECT current_version_id,status FROM sources WHERE id=$1', [source.id]))[0]
    check(current?.current_version_id === payload.version_id && current?.status === 'active', 'El archivo cambió durante el procesamiento; se conservaron sus nuevas versiones', 409)
    signal.throwIfAborted()
    const saved = await store.ingestWithinOriginals({ ...original, title: source.title, project_ids: inherited.map(r => r.to_id),
      fragments: [...base, ...parts], metadata: { ...original.metadata, media_processing: { key: payload.key, revision: MEDIA_REVISION, settings,
        processed_at: new Date().toISOString(), generated_parts: parts.length, warnings: result.warnings, previous_version: payload.version_id } } }, 'worker:media', true)
    const fragments = await sql.query('SELECT id,metadata FROM fragments WHERE version_id=$1', [saved.version_id])
    for (const fragment of fragments) {
      if (fragment.metadata.analysis_key !== payload.key || !fragment.metadata.media_embedding) continue
      const embedding = result.parts[fragment.metadata.analysis_part]?.vector
      check(embedding && embedding.length === 768 && embedding.every(Number.isFinite), 'Embedding multimedia incompleto', 422)
      await sql.query(`INSERT INTO embeddings(fragment_id,model,dimension,embedding) VALUES($1,$2,768,$3)
        ON CONFLICT(fragment_id,model) DO UPDATE SET embedding=excluded.embedding,created_at=now()`, [fragment.id,NATIVE_EMBEDDING_MODEL,vector(embedding)])
    }
    return { stage: 'complete', entity_id: saved.entity_id, version_id: saved.version_id, generated_parts: parts.length, media_warnings: result.warnings,
      ocr_parts: result.parts.filter(p => p.metadata.generated === 'ocr').length, transcription_parts: result.parts.filter(p => p.metadata.generated === 'transcription').length,
      media_embeddings: result.parts.filter(p => p.vector).length }
  }))
}
