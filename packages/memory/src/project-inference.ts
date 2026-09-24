import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { lenientItems, type MemoryAI } from './ai.js'
import type { AIConfig } from './config.js'
import type { Sql } from './database.js'
import { check, id, parse } from './contracts.js'
import { hash, requireEntity, type MemoryStore } from './store.js'

const verdictSchema = z.object({
  project_ref: z.string().max(20), confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string().min(1).max(1600), evidence_ids: z.array(z.string().max(20)).max(8),
  suggested_title: z.string().max(200), suggested_description: z.string().max(800),
}).strict()
const responseSchema = z.object({ verdicts: z.array(verdictSchema).max(1) }).strict()
export const PROJECT_SOURCE_KINDS = ['meeting', 'document'] as const

/** Sources the inference may classify: no project yet, no explicit "leave without project" decision, still current. */
export async function needsProject(sql: Sql, entityId: string): Promise<boolean> {
  const row = (await sql.query(`SELECT e.kind,e.data->>'project_decision' AS decision,
    EXISTS(SELECT 1 FROM links l WHERE l.from_id=e.id AND l.type='project') AS linked,
    EXISTS(SELECT 1 FROM sources s JOIN fragments f ON f.version_id=s.current_version_id JOIN fragment_projects fp ON fp.fragment_id=f.id WHERE s.entity_id=e.id) AS assigned
    FROM entities e WHERE e.id=$1`, [entityId]))[0]
  return Boolean(row && (PROJECT_SOURCE_KINDS as readonly string[]).includes(row.kind) && row.decision !== 'none' && !row.linked && !row.assigned)
}

/** Existing project context: what the model can compare against. Protected projects are omitted when the provider is remote. */
async function projectContext(store: MemoryStore, remote: boolean) {
  const projects = await store.db.query(`SELECT p.id,p.title,p.data->>'description' AS description,p.data->>'status' AS status,
    p.data->>'jira_project_key' AS jira_project_key,c.title AS company,
    ARRAY(SELECT s.title FROM links l JOIN entities s ON s.id=l.from_id WHERE l.to_id=p.id AND l.type='project' AND s.kind IN ('meeting','document','issue')
      ORDER BY COALESCE(s.data->>'occurred_at',s.created_at::text) DESC LIMIT 6) AS recent_sources,
    ARRAY(SELECT person.title FROM links l JOIN links part ON part.from_id=l.from_id AND part.type='participant' JOIN entities person ON person.id=part.to_id
      WHERE l.to_id=p.id AND l.type='project' GROUP BY person.id,person.title ORDER BY count(*) DESC,person.title LIMIT 15) AS usual_people
    FROM entities p LEFT JOIN entities c ON c.id=(p.data->>'company_id')::uuid
    WHERE p.kind='project' AND COALESCE(p.data->>'status','') NOT IN ('completed') AND ($1::boolean=false OR COALESCE(p.data->>'remote_processing','true')<>'false')
    ORDER BY p.updated_at DESC LIMIT 150`, [remote])
  return projects
}

/** Other occurrences of the same Calendar series already assigned to a project: the strongest deterministic signal. */
async function seriesProjects(store: MemoryStore, entityId: string): Promise<string[]> {
  const rows = await store.db.query(`SELECT DISTINCT pl.to_id AS project_id FROM links own
    JOIN entities event ON event.id=own.to_id AND event.kind='event' AND event.data->>'recurrence_id' IS NOT NULL
    JOIN entities sibling ON sibling.kind='event' AND sibling.data->>'recurrence_id'=event.data->>'recurrence_id'
    JOIN links meeting ON meeting.to_id=sibling.id AND meeting.type='calendar_event'
    JOIN links pl ON pl.from_id IN (meeting.from_id,sibling.id) AND pl.type='project'
    WHERE own.from_id=$1 AND own.type='calendar_event'`, [entityId])
  return rows.map(r => r.project_id as string)
}

export async function inferProject(store: MemoryStore, ai: MemoryAI, source: Record<string, any>, fragments: Record<string, any>[], config: AIConfig,
  remote: boolean, progress: (value: Record<string, unknown>) => Promise<void>, signal: AbortSignal) {
  const totals = { project_inference: 'skipped', project_input_tokens: 0, project_output_tokens: 0 }
  if (!fragments.length || !await needsProject(store.db, source.entity_id)) return totals
  const projects = await projectContext(store, remote)
  const key = hash({ version: source.current_version_id, projects: projects.map(p => [p.id, p.title, p.description]), model: config.extraction_model })
  const previous = (await store.db.query("SELECT metadata->>'project_inference_key' AS key FROM versions WHERE id=$1", [source.current_version_id]))[0]?.key
  if (previous === key) return totals
  signal.throwIfAborted()
  await progress({ stage: 'project_inference', request_started_at: new Date().toISOString() })
  const series = new Set(await seriesProjects(store, source.entity_id))
  const people = await store.db.query(`SELECT DISTINCT p.title,p.data->>'email' AS email FROM links l JOIN entities p ON p.id=l.to_id
    WHERE l.from_id=$1 AND l.type='participant' ORDER BY p.title LIMIT 40`, [source.entity_id])
  const facts = await store.db.query(`SELECT f.data->>'category' AS category,f.data->>'text' AS text FROM links d JOIN entities f ON f.id=d.from_id AND f.kind='fact'
    WHERE d.to_id=$1 AND d.type='derived_from' AND f.data->>'category' IN ('summary','decision','commitment','finding','risk') ORDER BY f.created_at LIMIT 25`, [source.entity_id])
  // The opening minutes carry introductions and the agenda; evenly spaced samples cover the rest of a long meeting.
  const picked = new Set<number>(fragments.slice(0, 25).map((_, index) => index))
  for (let n = 0; n < 25 && fragments.length > 25; n++) picked.add(25 + Math.floor(n * (fragments.length - 25) / 25))
  const sample = [...picked].sort((a, b) => a - b).map(index => fragments[index]!)
  const projectRefs = new Map(projects.map((p, index) => [`p${index + 1}`, p.id as string]))
  const evidenceRefs = new Map(sample.map((f, index) => [`f${index + 1}`, f.id as string]))
  const result = await ai.extract(`Decide a qué proyecto existente pertenece esta fuente (reunión o documento), comparando su contenido con cada proyecto.
    Devuelve exactamente un veredicto. project_ref es p1/p2/etc de la lista, o "none" si ninguno corresponde.
    Confianza alta sólo con evidencia directa: se nombra el proyecto, su cliente o su clave de Jira; la serie recurrente del calendario ya pertenece a ese proyecto (same_calendar_series); o participan las mismas personas externas habituales del proyecto hablando del mismo trabajo.
    Coincidencias genéricas (mismo equipo interno, temas comunes, un nombre parecido) son confianza media o baja. Si puede ser de varios proyectos, baja la confianza.
    Si no corresponde a ninguno y trata un trabajo concreto con un cliente o una iniciativa, propón en suggested_title un nombre breve de proyecto y en suggested_description una descripción de una o dos oraciones; si es una reunión suelta (1:1, social, organizativa general) déjalos vacíos.
    Cita en evidence_ids hasta 5 fragmentos f1/f2/etc que respalden el veredicto. En reason explica la evidencia y las dudas con nombres legibles, sin códigos p1/f1.`,
  { source: { title: source.title, kind: source.kind ?? source.data?.kind, occurred_at: source.data?.occurred_at ?? null, participants: people },
    extracted_facts: facts,
    projects: projects.map((p, index) => ({ id: `p${index + 1}`, title: p.title, description: p.description ?? '', company: p.company ?? '', status: p.status ?? '',
      jira_project_key: p.jira_project_key ?? '', recent_sources: p.recent_sources, usual_people: p.usual_people, same_calendar_series: series.has(p.id) })),
    fragments: sample.map((f, index) => ({ id: `f${index + 1}`, speaker: f.speaker_name ?? null, text: String(f.text).slice(0, 500) })) },
  responseSchema, raw => raw as z.infer<typeof responseSchema>)
  signal.throwIfAborted()
  totals.project_input_tokens = result.usage.input_tokens; totals.project_output_tokens = result.usage.output_tokens
  const verdict = lenientItems(result.value, 'verdicts', verdictSchema)[0]
  check(verdict && (verdict.project_ref === 'none' || projectRefs.has(verdict.project_ref)), 'El modelo no devolvió un veredicto de proyecto válido', 502)
  const projectId = verdict ? projectRefs.get(verdict.project_ref) : undefined
  const evidence = (verdict?.evidence_ids ?? []).map(ref => evidenceRefs.get(ref)).filter((v): v is string => Boolean(v))
  const reason = (verdict?.reason ?? 'El modelo no devolvió un veredicto válido.').replace(/\b([pf]\d+)\b/g, ref => {
    const project = projectRefs.get(ref)
    if (project) return projects.find(p => p.id === project)!.title as string
    const fragment = evidenceRefs.get(ref)
    return fragment ? `fragmento #${Number(fragments.find(f => f.id === fragment)?.ordinal ?? 0) + 1}` : ref
  })
  const confidence = projectId ? verdict!.confidence : verdict?.confidence ?? 'low'
  const auto = Boolean(projectId && evidence.length > 0 && confidence === 'high' && config.project_auto_assign !== false)
  const proposalId = await store.db.transaction(async sql => {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`project-inference:${source.entity_id}`])
    check((await sql.query('SELECT current_version_id FROM sources WHERE id=$1', [source.id]))[0]?.current_version_id === source.current_version_id, 'La fuente cambió; vuelve a inferir su proyecto', 409)
    if (!await needsProject(sql, source.entity_id)) return null
    await sql.query("UPDATE entities SET data=data || jsonb_build_object('review_state','superseded'),updated_at=now() WHERE kind='fact' AND data->>'category'='project_match' AND data->>'source_entity_id'=$1 AND data->>'review_state'='pending'", [source.entity_id])
    const factId = randomUUID(), candidate = projectId ? projects.find(p => p.id === projectId) : undefined
    const text = candidate ? `${source.title} → ${candidate.title}` : `${source.title} no tiene proyecto`
    await sql.query("INSERT INTO entities(id,kind,title,data) VALUES($1,'fact',$2,$3)", [factId, text.slice(0, 500), JSON.stringify({
      category: 'project_match', text, source_entity_id: source.entity_id, source_title: source.title, source_kind: source.kind ?? null,
      candidate_project_id: candidate?.id ?? null, candidate_project_title: candidate?.title ?? null, confidence, reason,
      suggested_title: projectId ? '' : verdict?.suggested_title.trim() ?? '', suggested_description: projectId ? '' : verdict?.suggested_description.trim() ?? '',
      review_state: auto ? 'accepted' : 'pending', applied: auto ? 'auto' : null, reviewed_by: auto ? 'ai:auto' : null,
      source_version: source.current_version_id, model: result.usage.model, prompt_version: 'project-v1', stale: false })])
    for (const fragmentId of new Set(evidence)) await sql.query('INSERT INTO evidence VALUES($1,$2)', [factId, fragmentId])
    await sql.query("INSERT INTO links(id,from_id,to_id,type) VALUES($1,$2,$3,'derived_from')", [randomUUID(), factId, source.entity_id])
    if (auto) await assignSourceToProject(store, source.entity_id, projectId!, 'ai:auto', { proposal_id: factId, confidence, auto: true }, sql)
    return factId
  })
  await store.db.query("UPDATE versions SET metadata=metadata || jsonb_build_object('project_inference_key',$2::text) WHERE id=$1", [source.current_version_id, key])
  totals.project_inference = !proposalId ? 'skipped' : auto ? 'auto_assigned' : projectId ? 'suggested' : 'no_project'
  await progress({ ...totals })
  return { ...totals, project_id: auto ? projectId : null }
}

/**
 * Links the source and the documents and invitations tied to it (Docs transcript, Calendar event), so the whole meeting lands in one project.
 * Fragments inherit the project through store.link; derived facts inherit it through inheritFactProjects.
 */
async function assignSourceToProject(store: MemoryStore, entityId: string, projectId: string, actor: string, data: Record<string, unknown>, sql: Sql) {
  await requireEntity(sql, projectId, 'project')
  const related = await sql.query(`SELECT DISTINCT other.id FROM links l JOIN entities other ON other.id=CASE WHEN l.from_id=$1 THEN l.to_id ELSE l.from_id END
    WHERE (l.from_id=$1 OR l.to_id=$1) AND l.type IN ('meeting_document','calendar_event') AND other.kind IN ('meeting','document','event')
      AND NOT EXISTS(SELECT 1 FROM links p WHERE p.from_id=other.id AND p.type='project')`, [entityId])
  for (const target of [entityId, ...related.map(r => r.id as string)]) {
    await store.link({ from_id: target, to_id: projectId, type: 'project', data: target === entityId ? data : { ...data, via: entityId } }, actor, sql)
    await keepExtractionKey(sql, target)
  }
}

/** A project change alone must not re-extract facts: the stored key is refreshed to the new fragment assignment. */
async function keepExtractionKey(sql: Sql, entityId: string) {
  const version = (await sql.query("SELECT v.id,v.metadata->>'extraction_key' AS key FROM sources s JOIN versions v ON v.id=s.current_version_id WHERE s.entity_id=$1", [entityId]))[0]
  if (!version?.key) return
  const fragments = await sql.query(`SELECT f.id,f.speaker_id,COALESCE((SELECT jsonb_agg(fp.project_id) FROM fragment_projects fp WHERE fp.fragment_id=f.id),'[]') AS project_ids
    FROM fragments f WHERE f.version_id=$1 ORDER BY ordinal`, [version.id])
  const next = String(version.key).replace(/[^:]+$/, extractionHash(fragments))
  await sql.query("UPDATE versions SET metadata=metadata || jsonb_build_object('extraction_key',$2::text) WHERE id=$1", [version.id, next])
}
export function extractionHash(fragments: Record<string, any>[]) {
  return hash(fragments.map(f => ({ id: f.id, projects: f.project_ids, speaker: f.speaker_id })))
}

export const projectSuggestionReview = z.discriminatedUnion('decision', [
  z.object({ id, decision: z.literal('assign'), project_id: id }).strict(),
  z.object({ id, decision: z.literal('create'), title: z.string().trim().min(1).max(500), description: z.string().trim().max(4000).default(''), company_id: id.optional() }).strict(),
  z.object({ id, decision: z.literal('none') }).strict(),
])

export async function reviewProjectSuggestion(store: MemoryStore, raw: unknown, actor: string) {
  const input = parse(projectSuggestionReview, raw)
  return store.db.transaction(async sql => {
    await sql.query('SELECT id FROM entities WHERE id=$1 FOR UPDATE', [input.id])
    const proposal = await requireEntity(sql, input.id, 'fact'), p = proposal.data
    check(p.category === 'project_match', 'La propuesta no corresponde a un proyecto')
    check(p.review_state === 'pending', 'La propuesta ya fue revisada', 409)
    const sourceId = p.source_entity_id as string
    await requireEntity(sql, sourceId)
    let projectId: string | null = null
    if (input.decision === 'create') {
      const project = await store.create({ kind: 'project', title: input.title, data: { description: input.description, status: 'discovery',
        ...(input.company_id ? { company_id: input.company_id } : {}) } }, actor, sql)
      projectId = project.id
    } else if (input.decision === 'assign') projectId = input.project_id
    if (projectId) await assignSourceToProject(store, sourceId, projectId, actor, { proposal_id: proposal.id }, sql)
    else await sql.query("UPDATE entities SET data=data || '{\"project_decision\":\"none\"}'::jsonb,updated_at=now() WHERE id=$1", [sourceId])
    await sql.query("UPDATE entities SET data=data || jsonb_build_object('review_state',$2::text,'reviewed_by',$3::text,'applied',$4::text,'project_id',$5::text),updated_at=now() WHERE id=$1",
      [proposal.id, projectId ? 'accepted' : 'rejected', actor, input.decision, projectId])
    await sql.query("INSERT INTO changes(entity_id,action,actor,after_value) VALUES($1,'project.reviewed',$2,$3)", [sourceId, actor, JSON.stringify({ proposal_id: proposal.id, decision: input.decision, project_id: projectId })])
    return { reviewed: true, decision: input.decision, project_id: projectId, source_entity_id: sourceId }
  })
}

/** Pending suggestions with what a person needs to decide: the source, its people, what was extracted and the candidate. */
export async function listProjectSuggestions(store: MemoryStore, input: { state: string; limit: number; offset: number }) {
  const where = `e.kind='fact' AND e.data->>'category'='project_match' AND e.data->>'review_state'=$1`
  const items = await store.db.query(`SELECT e.*,src.title AS source_title,src.kind AS source_kind,src.data->>'occurred_at' AS occurred_at,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'title',p.title,'email',p.data->>'email') ORDER BY p.title),'[]') FROM links l JOIN entities p ON p.id=l.to_id
      WHERE l.from_id=src.id AND l.type='participant') AS participants,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',f.id,'category',f.data->>'category','text',f.data->>'text') ORDER BY f.created_at),'[]') FROM (
      SELECT f.* FROM links d JOIN entities f ON f.id=d.from_id AND f.kind='fact' WHERE d.to_id=src.id AND d.type='derived_from'
        AND f.data->>'category' IN ('summary','decision','commitment','finding','risk') ORDER BY f.created_at LIMIT 8) f) AS facts,
    (SELECT count(*)::int FROM links d JOIN entities f ON f.id=d.from_id AND f.kind='fact' WHERE d.to_id=src.id AND d.type='derived_from'
      AND f.data->>'category' IN ('summary','decision','commitment','finding','risk')) AS fact_count
    FROM entities e JOIN entities src ON src.id=(e.data->>'source_entity_id')::uuid WHERE ${where}
    ORDER BY COALESCE(src.data->>'occurred_at',src.created_at::text) DESC,e.id LIMIT $2 OFFSET $3`, [input.state, input.limit, input.offset])
  const total = (await store.db.query(`SELECT count(*)::int AS total FROM entities e JOIN entities src ON src.id=(e.data->>'source_entity_id')::uuid WHERE ${where}`, [input.state]))[0]!.total
  return { items, total, limit: input.limit, offset: input.offset }
}
