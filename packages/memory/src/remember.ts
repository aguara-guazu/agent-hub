import { z } from 'zod'
import { check, id, instant, parse } from './contracts.js'
import { hash, requireEntity, validateEvidence, type MemoryStore } from './store.js'
import { splitText } from './transcript.js'

export const rememberInput = z.object({ key: z.string().trim().min(1).max(200), title: z.string().trim().min(1).max(500),
  text: z.string().trim().min(1).max(20_000), project_id: id.optional(),
  category: z.enum(['preference', 'decision', 'lesson', 'procedure', 'context']).default('context'),
  confidence: z.enum(['observed', 'confirmed', 'inferred']).default('observed'),
  importance: z.number().int().min(1).max(5).default(3), tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  evidence_ids: z.array(id).max(100).default([]), expires_at: instant.optional(),
  expected_updated_at: instant.optional(), remote_processing: z.boolean().default(false),
}).strict()
export const manageMemoryInput = z.object({ id, action: z.enum(['archive', 'restore', 'pin', 'unpin']),
  reason: z.string().trim().min(1).max(1000), duplicate_of: id.optional(), expected_updated_at: instant }).strict()

export async function remember(store: MemoryStore, raw: unknown, actor: string) {
  const input = parse(rememberInput, raw)
  if (input.project_id) await requireEntity(store.db, input.project_id, 'project')
  await validateEvidence(store.db, input.evidence_ids)
  const { expected_updated_at, ...value } = input
  const signature = hash(value), external = `memory:${input.project_id ?? 'global'}:${input.key}`
  return store.db.withOriginals(() => store.db.transaction(async sql => {
    const previous = (await sql.query(`SELECT e.*,s.id AS source_id,s.current_version_id FROM entities e JOIN sources s ON s.entity_id=e.id
      WHERE s.provider='manual' AND s.account='local' AND s.external_id=$1`, [external]))[0]
    if (previous?.data.memory_payload_hash === signature && previous.title === input.title && previous.data.text === input.text && previous.data.memory_state !== 'archived') {
      return { entity_id: previous.id, source_id: previous.source_id, version_id: previous.current_version_id, duplicate: true }
    }
    if (previous) check(expected_updated_at && Date.parse(expected_updated_at) === Date.parse(previous.updated_at),
      'El recuerdo ya existe o cambió. Leelo con get_entity y enviá expected_updated_at para corregirlo.', 409)
    // ingest manages originals itself; nested DB transactions are supported, but do not reacquire its originals lock.
    const imported = await store.ingestWithinOriginals({ kind: 'note', title: input.title, external_id: external,
      project_ids: input.project_id ? [input.project_id] : [],
      fragments: splitText(input.text).map(fragment => ({ ...fragment, metadata: { ...fragment.metadata, memory_payload_hash: signature } })),
      metadata: { agent_memory: true, text: input.text, memory_key: input.key, memory_project_id: input.project_id ?? null,
        memory_category: input.category, memory_confidence: input.confidence, memory_importance: input.importance,
        memory_tags: input.tags, memory_expires_at: input.expires_at ?? null, memory_state: 'active', memory_author: actor,
        memory_archive_reason: null, memory_duplicate_of: null,
        memory_payload_hash: signature, remote_processing: input.remote_processing },
      original: value,
    }, actor)
    await sql.query('DELETE FROM evidence WHERE entity_id=$1', [imported.entity_id])
    for (const fragmentId of input.evidence_ids) await sql.query('INSERT INTO evidence(entity_id,fragment_id) VALUES($1,$2)', [imported.entity_id, fragmentId])
    return imported
  }))
}

export async function manageMemory(store: MemoryStore, raw: unknown, actor: string) {
  const input = parse(manageMemoryInput, raw)
  return store.db.transaction(async sql => {
    const entity = await requireEntity(sql, input.id)
    check(entity.data.agent_memory === true, 'Esta operación es sólo para recuerdos del agente; los originales se conservan', 409)
    check(Date.parse(entity.updated_at) === Date.parse(input.expected_updated_at), 'El recuerdo cambió; volvé a leerlo antes de modificarlo', 409)
    if (input.duplicate_of) {
      check(input.action === 'archive' && input.duplicate_of !== input.id, 'El destino del duplicado no es válido')
      const target = await requireEntity(sql, input.duplicate_of)
      check(target.data.agent_memory === true && target.data.memory_state !== 'archived' && target.data.memory_project_id === entity.data.memory_project_id, 'El recuerdo vigente debe estar activo y en el mismo ámbito')
    }
    const patch = input.action === 'pin' || input.action === 'unpin' ? { memory_pinned: input.action === 'pin' }
      : { memory_state: input.action === 'archive' ? 'archived' : 'active', memory_archive_reason: input.action === 'archive' ? input.reason : null,
        memory_duplicate_of: input.action === 'archive' ? input.duplicate_of ?? null : null,
        ...(input.action === 'restore' ? { memory_pinned: true } : {}) }
    const next: Record<string, any> = { ...entity.data, ...patch }
    await sql.query('UPDATE entities SET data=$2,updated_at=now() WHERE id=$1', [input.id, JSON.stringify(next)])
    if (input.action === 'archive' || input.action === 'restore') await sql.query('UPDATE sources SET status=$2 WHERE entity_id=$1', [input.id, input.action === 'archive' ? 'archived' : 'active'])
    await sql.query('INSERT INTO changes(entity_id,action,actor,before_value,after_value) VALUES($1,$2,$3,$4,$5)',
      [input.id, `memory.${input.action}`, actor, JSON.stringify(entity), JSON.stringify({ ...next, reason: input.reason })])
    return { id: input.id, state: next.memory_state, pinned: next.memory_pinned ?? false, retained_originals: true }
  })
}
