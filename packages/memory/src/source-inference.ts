import { z } from 'zod'
import type { MemoryAI } from './ai.js'
import { usesRemoteExtraction, type AIConfig } from './config.js'
import { audit, type MemoryStore } from './store.js'

/** Content beyond this prefix rarely changes a title or a summary and only adds latency and tokens. */
const MAX_CONTENT_CHARS = 18_000
const MAX_IDENTIFIER_LENGTH = 100
const inferenceSchema = z.object({
  title: z.string().trim().min(1).max(200),
  identifier: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(1200),
}).strict()

/** Lowercase ASCII kebab-case: accents are folded and anything else becomes a single dash. */
export function slugIdentifier(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_IDENTIFIER_LENGTH).replace(/-+$/, '')
}

/**
 * Infers title, external_id and description of an upload flagged with `infer_metadata` from its readable content.
 *
 * Runs once per source: `data.inferred_metadata` marks it done and later versions keep the result. A manual title is
 * never replaced. The external_id is renamed in place; a collision with another source gets a numeric suffix, so an
 * inferred identifier never merges two sources. Sources whose projects forbid remote processing are only sent to
 * local models, mirroring fact extraction.
 */
export async function inferSourceMetadata(store: MemoryStore, ai: MemoryAI, versionId: string, config: AIConfig,
  progress: (value: Record<string, unknown>) => Promise<void>, signal: AbortSignal) {
  const source = (await store.db.query(`SELECT s.*,e.title,e.kind,e.data FROM sources s JOIN entities e ON e.id=s.entity_id
    WHERE s.current_version_id=$1 AND s.status='active'`, [versionId]))[0]
  if (!source) return { skipped: 'historical_version' }
  if (source.data.infer_metadata !== true || source.data.inferred_metadata) return { skipped: 'already_inferred' }
  await progress({ entity_id: source.entity_id, source_title: source.title, version_id: versionId, provider: config.extraction,
    model: config.extraction_model, stage: 'metadata_inference' })
  const protectedProjects = await store.db.query(`SELECT id FROM entities WHERE kind='project' AND (data->>'remote_processing') IN (0,'false')
    AND id IN(SELECT to_id FROM links WHERE from_id=$1 AND type='project')`, [source.entity_id])
  const allowedRemote = source.data.remote_processing !== false && protectedProjects.length === 0
  if (!config.extraction_model || config.extraction === 'disabled') return { stage: 'complete', metadata_inference: 'not_configured' }
  if (usesRemoteExtraction(config) && !(config.remote_processing_enabled && allowedRemote)) return { stage: 'complete', metadata_inference: 'disabled_for_source' }
  const fragments = await store.db.query<{ text: string; metadata: Record<string, unknown> }>('SELECT text,metadata FROM fragments WHERE version_id=$1 ORDER BY ordinal', [versionId])
  const content = fragments.filter(f => f.metadata?.annotation !== true).map(f => f.text).join('\n').slice(0, MAX_CONTENT_CHARS)
  if (!content.trim()) return { stage: 'complete', metadata_inference: 'no_content' }
  const attachment = source.data.attachment as { filename?: string } | undefined
  const result = await ai.extract('Describe the source from its content. title: short, specific, recognizable in a list; no file extension or upload dates. '
    + 'identifier: stable, readable lowercase kebab-case, no spaces or accents; a date only if the content states one. '
    + 'summary: 1-3 sentences on what it is, its topic and purpose; invent nothing absent from the content.',
  { filename: attachment?.filename ?? null, kind: source.kind, occurred_at: source.data.occurred_at ?? null, content }, inferenceSchema)
  signal.throwIfAborted()
  const base = slugIdentifier(result.value.identifier) || slugIdentifier(result.value.title) || `fuente-${String(source.id).slice(0, 8)}`
  const applied = await store.db.transaction(async sql => {
    const current = (await sql.query(`SELECT s.current_version_id,s.external_id,e.title,e.data FROM sources s JOIN entities e ON e.id=s.entity_id WHERE s.id=$1`, [source.id]))[0]
    if (current?.current_version_id !== versionId || current.data.inferred_metadata) return null
    let externalId = base
    for (let suffix = 2; (await sql.query('SELECT 1 FROM sources WHERE provider=$1 AND account=$2 AND external_id=$3 AND id<>$4', [source.provider, source.account, externalId, source.id])).length; suffix++) {
      externalId = `${base.slice(0, MAX_IDENTIFIER_LENGTH - String(suffix).length - 1)}-${suffix}`
    }
    const manualTitle = current.data.manual_title === true || current.data.manual_title === 1
    const inferred = { title: result.value.title, external_id: externalId, summary: result.value.summary, previous_external_id: current.external_id,
      version_id: versionId, model: result.usage.model, inferred_at: new Date().toISOString() }
    await sql.query('UPDATE sources SET external_id=$2 WHERE id=$1', [source.id, externalId])
    await sql.query(`UPDATE entities SET title=$2,data=jsonb_merge(data,$3),updated_at=clock_timestamp() WHERE id=$1`, [source.entity_id,
      manualTitle ? current.title : result.value.title,
      JSON.stringify({ inferred_metadata: inferred, ...(current.data.description ? {} : { description: result.value.summary }) })])
    await audit(sql, source.entity_id, 'metadata.inferred', 'worker:inference', { title: current.title, external_id: current.external_id }, inferred)
    return inferred
  })
  return { stage: 'complete', metadata_inference: applied ? 'applied' : 'superseded', ...(applied ? { inferred_title: applied.title, inferred_external_id: applied.external_id } : {}),
    input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens, model: result.usage.model }
}
