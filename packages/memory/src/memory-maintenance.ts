import { z } from 'zod'
import { check, id, parse } from './contracts.js'
import { hash, requireEntity, type MemoryStore } from './store.js'
import { manageMemory } from './remember.js'
import type { AIConfig } from './config.js'

export const tidyInput = z.object({ project_id: id.optional(), force: z.boolean().default(false),
  reason: z.string().trim().min(1).max(500).default('Mantenimiento periódico de recuerdos') }).strict()
export const maintenanceStatusInput = z.object({ project_id: id.optional() }).strict()
export const listMemoriesInput = z.object({ project_id: id.optional(), state: z.enum(['active', 'archived', 'all']).default('active'),
  query: z.string().max(500).default(''), limit: z.number().int().min(1).max(100).default(30), offset: z.number().int().nonnegative().default(0) }).strict()
const key = (project?: string) => `memory-tidy:${project ?? 'all'}`
export async function maintenanceStatus(store: MemoryStore, project?: string) {
  if (project) await requireEntity(store.db, project, 'project')
  const last = (await store.db.query('SELECT value FROM settings WHERE key=$1', [key(project)]))[0]?.value ?? null
  const active = (await store.db.query("SELECT id,state,progress FROM jobs WHERE dedupe_key=$1 AND state IN ('queued','running','waiting')", [key(project)]))[0] ?? null
  return { last, active, due: !active && (!last?.finished_at || Date.now() - Date.parse(last.finished_at) >= 24 * 60 * 60_000) }
}
export async function requestTidy(store: MemoryStore, raw: unknown, actor: string) {
  const input = parse(tidyInput, raw), status = await maintenanceStatus(store, input.project_id)
  if (status.active) return { queued: true, job_id: status.active.id, duplicate: true }
  if (!input.force && !status.due) return { queued: false, reason: 'La memoria ya se revisó en las últimas 24 horas', last: status.last }
  const job = await store.enqueue('tidy_memory', { ...input, actor }, key(input.project_id))
  return { queued: true, job_id: job.id }
}
export async function listMemories(store: MemoryStore, raw: unknown) {
  const input = parse(listMemoriesInput, raw)
  if (input.project_id) await requireEntity(store.db, input.project_id, 'project')
  const where = `e.data->>'agent_memory' IN (1,'true') AND ($1 IS NULL OR e.data->>'memory_project_id'=$1)
    AND ($2='all' OR COALESCE(e.data->>'memory_state','active')=$2)
    AND ($3='' OR ilike(e.title,'%'||$3||'%') OR ilike(e.data->>'text','%'||$3||'%'))`
  const params = [input.project_id ?? null, input.state, input.query]
  const items = await store.db.query(`SELECT e.* FROM entities e WHERE ${where}
    ORDER BY (e.data->>'memory_pinned') IN (1,'true') DESC,CAST(e.data->>'memory_importance' AS INTEGER) DESC,e.updated_at DESC,e.id LIMIT $4 OFFSET $5`, [...params,input.limit,input.offset])
  const total = (await store.db.query(`SELECT count(*) AS total FROM entities e WHERE ${where}`, params))[0]!.total
  return { items, total, limit: input.limit, offset: input.offset }
}

/** Local, bounded housekeeping. Similarity proposes candidates; it cannot establish truth or delete evidence. */
export async function tidyMemory(store: MemoryStore, config: AIConfig, raw: unknown, signal: AbortSignal,
  progress: (value: Record<string, unknown>) => Promise<void>) {
  const { actor, ...input } = raw as z.infer<typeof tidyInput> & { actor: string }
  const scope = parse(tidyInput, input)
  if (scope.project_id) await requireEntity(store.db, scope.project_id, 'project')
  await progress({ source_title: 'Organización de la memoria', stage: 'memory_maintenance', provider: 'local', model: config.embeddings_enabled ? config.embedding_model : null })
  const rows = await store.db.query(`SELECT e.* FROM entities e WHERE e.data->>'agent_memory' IN (1,'true')
    AND COALESCE(e.data->>'memory_state','active')='active' AND ($1 IS NULL OR e.data->>'memory_project_id'=$1)
    ORDER BY COALESCE(e.data->>'memory_last_reviewed_at',''),e.created_at,e.id LIMIT 500`, [scope.project_id ?? null])
  const now = new Date().toISOString(), canonical = new Map<string, Record<string, any>>()
  let archived = 0, duplicates = 0, reviewed = 0
  const archivedIds: string[] = []
  for (const row of rows) {
    signal.throwIfAborted()
    // Same wording in different projects or with different confidence/expiry is not the same memory.
    const fingerprint = hash({ title: row.title, text: row.data.text, project: row.data.memory_project_id,
      category: row.data.memory_category, confidence: row.data.memory_confidence, expiry: row.data.memory_expires_at, tags: row.data.memory_tags })
    const previous = canonical.get(fingerprint)
    const expired = row.data.memory_expires_at && Date.parse(row.data.memory_expires_at) <= Date.now()
    if (!row.data.memory_pinned && (expired || previous)) {
      try {
        await store.db.transaction(async sql => {
          if (previous && !expired) {
            const target = await requireEntity(sql, previous.id)
            check(target.data.memory_state !== 'archived' && target.updated_at === previous.updated_at, 'El recuerdo de destino cambió', 409)
            await sql.query('INSERT INTO evidence(entity_id,fragment_id) SELECT $1,fragment_id FROM evidence WHERE entity_id=$2 ON CONFLICT DO NOTHING', [previous.id,row.id])
          }
          await manageMemory(store, { id: row.id, action: 'archive', expected_updated_at: row.updated_at,
            reason: expired ? 'Venció la fecha de vigencia indicada al guardar el recuerdo' : `Duplicado exacto del recuerdo ${previous!.id}`,
            ...(!expired && previous ? { duplicate_of: previous.id } : {}) }, `worker:${actor}`)
        })
        archived++; if (!expired) duplicates++; archivedIds.push(row.id)
      } catch (error) { if (!(error instanceof Error && 'statusCode' in error && error.statusCode === 409)) throw error }
    } else if (!previous) canonical.set(fingerprint, row)
    // Only a maintenance timestamp changes; it does not change embedding text or optimistic edit tokens.
    await store.db.query("UPDATE entities SET data=jsonb_merge(data,json_object('memory_last_reviewed_at',$2)) WHERE id=$1", [row.id,now])
    reviewed++; await progress({ memories_reviewed: reviewed, memories_total: rows.length, memories_archived: archived, memory_duplicates: duplicates })
  }
  signal.throwIfAborted()
  // Search uses current source versions. Historical citations retain originals and text without retaining redundant vectors.
  const pruned = await store.db.query(`DELETE FROM embeddings WHERE fragment_id IN (
    SELECT f.id FROM fragments f JOIN versions v ON v.id=f.version_id JOIN sources s ON s.id=v.source_id
    WHERE f.version_id<>s.current_version_id AND ($1 IS NULL OR EXISTS(SELECT 1 FROM fragment_projects fp WHERE fp.fragment_id=f.id AND fp.project_id=$1))
  ) RETURNING fragment_id`, [scope.project_id ?? null])
  const candidates = config.embeddings_enabled ? await store.db.query(`WITH candidates AS MATERIALIZED (
    SELECT e.id,e.title,e.updated_at,e.data->>'memory_project_id' AS project,emb.embedding FROM entities e
      JOIN entity_embeddings emb ON emb.entity_id=e.id AND emb.model=$2 AND emb.content_hash=md5(memory_entity_text(e.title,e.data))
      WHERE e.data->>'agent_memory' IN (1,'true') AND COALESCE(e.data->>'memory_state','active')='active'
        AND ($1 IS NULL OR e.data->>'memory_project_id'=$1) ORDER BY e.updated_at DESC LIMIT 200
  ), pairs AS MATERIALIZED (
    SELECT a.id AS first_id,b.id AS second_id,a.title AS first_title,b.title AS second_title,
      vec_distance(a.embedding,b.embedding) AS distance FROM candidates a JOIN candidates b ON a.id<b.id AND a.project IS b.project
  ) SELECT *,1-distance AS similarity FROM pairs WHERE distance<0.12 ORDER BY distance,first_id,second_id LIMIT 30`, [scope.project_id ?? null,config.embedding_model]) : []
  const result = { stage: 'complete', finished_at: new Date().toISOString(), memories_reviewed: reviewed, memories_archived: archived, memory_duplicates: duplicates,
    historical_vectors_removed: pruned.length, archived_ids: archivedIds, related_memories: candidates,
    guidance: 'Los pares por significado requieren leer ambos recuerdos y su evidencia. La similitud no prueba duplicación ni contradicción. Corregí con remember y la fecha vigente; archivá con manage_memory. Los originales y citas se conservan.' }
  await store.db.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key(scope.project_id), JSON.stringify(result)])
  return result
}
