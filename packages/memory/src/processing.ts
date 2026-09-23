import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { MemoryStore } from './store.js'
import { hash, requireEntity, validateEvidence, validateProjects } from './store.js'
import { fieldsSchema, parse, check } from './contracts.js'
import { lenientItems, type MemoryAI } from './ai.js'
import { usesRemoteExtraction, type AIConfig } from './config.js'
import { inferIdentities } from './identity-inference.js'

const factSchema = z.object({ category: z.enum(['summary', 'decision', 'commitment', 'finding', 'risk']),
  text: z.string().min(1).max(3000), evidence_ids: z.array(z.string().uuid()).min(1).max(30),
  project_ids: z.array(z.string().uuid()).max(20).default([]),
}).strict()
const extractionSchema = z.object({ facts: z.array(factSchema).max(50) }).strict()
const ruleResult = z.object({ records: z.array(z.object({ values: z.record(z.string(), z.json()),
  evidence_ids: z.array(z.string().uuid()).min(1).max(30),
}).strict()).max(100) }).strict()

export async function processVersion(store: MemoryStore, ai: MemoryAI, versionId: string, config: AIConfig,
  progress: (value: Record<string, unknown>) => Promise<void>, signal: AbortSignal, force = false, identityOnly = false) {
  const source = (await store.db.query(`SELECT s.*,e.title,e.data FROM sources s JOIN entities e ON e.id=s.entity_id WHERE s.current_version_id=$1 AND s.status='active'`, [versionId]))[0]
  if (!source) return { skipped: 'historical_version' }
  const fragments = await store.db.query(`SELECT f.id,f.text,f.speaker_id,f.start_time,f.end_time,f.offset_ms,
    COALESCE((SELECT jsonb_agg(fp.project_id) FROM fragment_projects fp WHERE fp.fragment_id=f.id),'[]') AS project_ids,
    p.title AS speaker_name,p.data->>'email' AS speaker_email FROM fragments f LEFT JOIN entities p ON p.id=f.speaker_id WHERE version_id=$1 ORDER BY ordinal`, [versionId])
  const protectedProjects = await store.db.query(`SELECT id FROM entities WHERE kind='project' AND data->>'remote_processing'='false'
    AND (id IN(SELECT to_id FROM links WHERE from_id=$1 AND type='project')
      OR id IN(SELECT fp.project_id FROM fragment_projects fp JOIN fragments f ON f.id=fp.fragment_id WHERE f.version_id=$2))`, [source.entity_id, versionId])
  const allowedRemote = source.data.remote_processing !== false && protectedProjects.length === 0
  await progress({ entity_id: source.entity_id, source_title: source.title, version_id: versionId, provider: config.extraction,
    model: config.extraction_model, total_fragments: fragments.length, stage: 'preparing' })
  let embeddings = 0, extracted = 0, inputTokens = 0, outputTokens = 0, extractionRejected = 0, dedupeNeeded = false
  if (config.embeddings_enabled && !identityOnly) {
    const existing = new Set((await store.db.query('SELECT fragment_id FROM embeddings WHERE model=$1 AND fragment_id=ANY($2::uuid[])', [config.embedding_model, fragments.map(f => f.id)])).map(r => r.fragment_id))
    const pending = fragments.filter(f => force || !existing.has(f.id))
    for (let offset = 0; offset < pending.length; offset += 8) {
      signal.throwIfAborted()
      const batch = pending.slice(offset, offset + 8)
      await progress({ stage: 'embeddings', embeddings, embedding_total: pending.length })
      const result = await ai.embed(batch.map(f => f.text))
      signal.throwIfAborted()
      await store.db.transaction(async sql => {
        for (const [index, vector] of result.vectors.entries()) await sql.query(`INSERT INTO embeddings(fragment_id,model,dimension,embedding) VALUES($1,$2,$3,$4::vector)
          ON CONFLICT(fragment_id,model) DO UPDATE SET dimension=excluded.dimension,embedding=excluded.embedding,created_at=now()`, [batch[index]!.id, result.model, vector.length, JSON.stringify(vector)])
      })
      embeddings += batch.length
      await progress({ stage: 'embeddings', embeddings, total_fragments: fragments.length })
    }
  }
  const extractionAllowed = config.extraction !== 'disabled' && (!usesRemoteExtraction(config) || (config.remote_processing_enabled && allowedRemote))
  if (extractionAllowed) {
    const identities = await inferIdentities(store, ai, source, usesRemoteExtraction(config), config.extraction_model, async p => {
      await progress({ ...p, ...(typeof p.identity_input_tokens === 'number' ? { input_tokens: inputTokens + p.identity_input_tokens, output_tokens: outputTokens + Number(p.identity_output_tokens ?? 0) } : {}) })
    }, signal, config.identity_auto_merge)
    inputTokens += identities.identity_input_tokens; outputTokens += identities.identity_output_tokens; extracted += identities.identity_suggestions
    dedupeNeeded ||= identities.identity_suggestions > 0 || identities.identity_auto_applied > 0
    await progress({ ...identities, extracted, input_tokens: inputTokens, output_tokens: outputTokens })
  }
  if (identityOnly) {
    if (dedupeNeeded) await store.enqueue('dedupe_people', {}, 'dedupe:people')
    return { stage: 'complete', input_tokens: inputTokens, output_tokens: outputTokens, extracted,
      extraction: extractionAllowed ? 'identities_processed' : config.extraction === 'disabled' ? 'not_configured' : 'disabled_for_source' }
  }
  const processingKey = `${config.extraction}:${config.extraction_model}:v1:${hash(fragments.map(f => ({ id: f.id, projects: f.project_ids, speaker: f.speaker_id })))}`
  const processed = (await store.db.query('SELECT metadata->>\'extraction_key\' AS key FROM versions WHERE id=$1', [versionId]))[0]?.key
  if (config.extraction !== 'disabled' && (!usesRemoteExtraction(config) || (config.remote_processing_enabled && allowedRemote)) && (force || processed !== processingKey)) {
    dedupeNeeded = true
    const projects = await store.db.query("SELECT id,title FROM entities WHERE kind='project' AND ($1::boolean=false OR COALESCE(data->>'remote_processing','true')<>'false') ORDER BY title LIMIT 500", [usesRemoteExtraction(config)])
    const planned = batches(fragments)
    let processedFragments = 0
    await progress({ stage: 'extraction', total_batches: planned.length, batch: 0, processed_fragments: 0, extracted, input_tokens: inputTokens, output_tokens: outputTokens })
    for (const [batchNumber, batch] of planned.entries()) {
      signal.throwIfAborted()
      await progress({ stage: 'extraction', current_batch: batchNumber + 1, request_started_at: new Date().toISOString() })
      let malformed = 0
      const result = await ai.extract('Extraé hechos y resúmenes breves. Asociá proyectos sólo si la evidencia los identifica. Las propuestas serán revisables. Incluí IDs de evidencia exactos. Usá únicamente las categorías del esquema.',
        { title: source.title, projects, fragments: batch }, extractionSchema, raw => raw as z.infer<typeof extractionSchema>)
      signal.throwIfAborted()
      const facts = lenientItems(result.value, 'facts', factSchema, () => { malformed++ })
      inputTokens += result.usage.input_tokens; outputTokens += result.usage.output_tokens; extractionRejected += malformed
      const allowed = new Set(batch.map(f => f.id))
      await store.db.transaction(async sql => {
        for (const fact of facts) {
          // A single hallucinated citation discards that fact, not the whole source.
          if (!fact.evidence_ids.every(e => allowed.has(e))) { extractionRejected++; continue }
          await validateEvidence(sql, fact.evidence_ids); await validateProjects(sql, fact.project_ids)
          const key = hash({ versionId, processingKey, category: fact.category, evidence: [...fact.evidence_ids].sort(), text: fact.text })
          const old = await sql.query("SELECT id FROM entities WHERE kind='fact' AND data->>'dedupe_key'=$1", [key])
          if (old.length) continue
          const factId = randomUUID()
          await sql.query("INSERT INTO entities(id,kind,title,data) VALUES($1,'fact',$2,$3)", [factId, fact.text.slice(0, 180), JSON.stringify({ text: fact.text,
            category: fact.category, review_state: 'pending', dedupe_key: key, source_version: versionId, model: result.usage.model,
            prompt_version: 'v1', occurred_at: source.data.occurred_at ?? null, stale: false })])
          for (const fragmentId of new Set(fact.evidence_ids)) await sql.query('INSERT INTO evidence VALUES($1,$2)', [factId, fragmentId])
          await sql.query("INSERT INTO links(id,from_id,to_id,type) VALUES($1,$2,$3,'derived_from')", [randomUUID(), factId, source.entity_id])
          // Proposed project associations never silently reassign source fragments.
          for (const project of new Set(fact.project_ids)) await sql.query("INSERT INTO links(id,from_id,to_id,type,data) VALUES($1,$2,$3,'project','{\"proposed\":true}')", [randomUUID(), factId, project])
          extracted++
        }
      })
      processedFragments += batch.length
      await progress({ stage: 'extraction', batch: batchNumber + 1, processed_fragments: processedFragments, extracted, extraction_rejected: extractionRejected, embeddings, input_tokens: inputTokens, output_tokens: outputTokens, model: result.usage.model })
    }
    await store.db.query("UPDATE versions SET metadata=metadata || jsonb_build_object('extraction_key',$2::text) WHERE id=$1", [versionId, processingKey])
  }
  if (config.extraction !== 'disabled' && (!usesRemoteExtraction(config) || (config.remote_processing_enabled && allowedRemote))) {
    const rules = await store.db.query('SELECT * FROM rules WHERE enabled=true ORDER BY created_at')
    for (const rule of rules) await runRule(store, ai, rule, versionId, fragments, signal)
  }
  // New speakers or fresh identity results can create duplicates across sources; one queued pass covers every version processed since.
  if (dedupeNeeded) await store.enqueue('dedupe_people', {}, 'dedupe:people')
  return { stage: 'complete', embeddings, extracted, extraction_rejected: extractionRejected, input_tokens: inputTokens, output_tokens: outputTokens,
    extraction: config.extraction === 'disabled' ? 'not_configured' : usesRemoteExtraction(config) && (!allowedRemote || !config.remote_processing_enabled) ? 'disabled_for_source' : 'processed' }
}

export async function runRule(store: MemoryStore, ai: MemoryAI, rule: Record<string, any>, versionId: string, fragments: Record<string, any>[], signal: AbortSignal) {
  const done = await store.db.query('SELECT 1 FROM rule_runs WHERE rule_id=$1 AND revision=$2 AND version_id=$3', [rule.id, rule.revision, versionId])
  if (done.length) return
  const selected = fragments.filter(f => (!rule.person_id || f.speaker_id === rule.person_id) && (!rule.project_ids.length || f.project_ids.some((p: string) => rule.project_ids.includes(p))))
  const collection = await requireEntity(store.db, rule.collection_id, 'collection')
  const fields = parse(fieldsSchema, collection.data.fields)
  for (const batch of batches(selected)) {
    signal.throwIfAborted()
    const current = (await store.db.query('SELECT enabled,revision FROM rules WHERE id=$1', [rule.id]))[0]
    if (!current?.enabled || current.revision !== rule.revision) return
    const result = await ai.extract(`Completá registros de la colección. Campos: ${JSON.stringify(fields)}. Regla del usuario: ${rule.instructions}`, { fragments: batch }, ruleResult)
    signal.throwIfAborted()
    const allowed = new Set(batch.map(f => f.id))
    for (const record of result.value.records) {
      check(record.evidence_ids.every(e => allowed.has(e)), 'La regla devolvió evidencia ajena al alcance')
      await store.addRecord(rule.collection_id, { ...record, idempotency_key: hash({ rule: rule.id, evidence: [...record.evidence_ids].sort(), values: record.values }) }, `rule:${rule.id}`)
    }
  }
  await store.db.query('INSERT INTO rule_runs(rule_id,revision,version_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [rule.id, rule.revision, versionId])
}
function batches(rows: Record<string, any>[]) {
  const out: Record<string, any>[][] = []
  let batch: Record<string, any>[] = [], length = 0
  for (const row of rows) {
    if ((length + row.text.length > 18_000 || batch.length >= 40) && batch.length) { out.push(batch); batch = []; length = 0 }
    batch.push(row); length += row.text.length
  }
  if (batch.length) out.push(batch)
  return out
}
