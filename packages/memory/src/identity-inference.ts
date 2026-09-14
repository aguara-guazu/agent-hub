import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { lenientItems, type MemoryAI } from './ai.js'
import type { MemoryStore } from './store.js'
import type { Sql } from './database.js'
import { hash, requireEntity } from './store.js'
import { check, MemoryError, parse, type Entity } from './contracts.js'
import { namesCompatible, unifyByEmail } from './people.js'

const matchSchema = z.object({
  speaker_id: z.string().max(100), candidate_id: z.string().max(100).nullable(), confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string().min(1).max(1600), evidence_ids: z.array(z.string().max(100)).min(1).max(12),
}).strict()
const responseSchema = z.object({ matches: z.array(matchSchema).max(30) }).strict()
type Match = z.infer<typeof matchSchema> & { candidate_id: string }
type Candidate = { id: string; email: string; names: string[]; origins: { kind: string; entity_id: string }[] }

/** Only known emails are selectable. The model returns candidate IDs, never email strings. */
export async function identityContext(store: MemoryStore, source: Record<string, any>, remote: boolean) {
  const permitted = `(NOT $2::boolean OR (COALESCE(e.data->>'remote_processing','true')<>'false'
    AND NOT EXISTS(SELECT 1 FROM links p JOIN entities project ON project.id=p.to_id WHERE p.from_id=e.id AND p.type='project' AND project.data->>'remote_processing'='false')
    AND NOT EXISTS(SELECT 1 FROM sources ps JOIN fragments pf ON pf.version_id=ps.current_version_id JOIN fragment_projects fp ON fp.fragment_id=pf.id
      JOIN entities project ON project.id=fp.project_id WHERE ps.entity_id=e.id AND project.data->>'remote_processing'='false')))`
  const related = await store.db.query(`WITH RECURSIVE context(id,depth) AS (
    SELECT $1::uuid,0 UNION SELECT CASE WHEN l.from_id=c.id THEN l.to_id ELSE l.from_id END,c.depth+1
    FROM context c JOIN links l ON (l.from_id=c.id OR l.to_id=c.id) AND l.type IN ('calendar_event','meeting_document') WHERE c.depth<3)
    SELECT DISTINCT e.id,e.kind,e.title,e.data FROM context c JOIN entities e ON e.id=c.id WHERE ${permitted} ORDER BY e.id LIMIT 100`, [source.entity_id, remote])
  const people = await store.db.query(`SELECT DISTINCT e.id,e.title,e.data FROM entities e WHERE e.kind='person' AND e.data->>'merged_into' IS NULL AND ${permitted}
    AND (NOT $2::boolean OR NOT EXISTS(SELECT 1 FROM links membership JOIN entities meeting ON meeting.id=membership.from_id
      WHERE membership.to_id=e.id AND membership.type='participant' AND (meeting.data->>'remote_processing'='false'
        OR EXISTS(SELECT 1 FROM links pl JOIN entities project ON project.id=pl.to_id WHERE pl.from_id=meeting.id AND pl.type='project' AND project.data->>'remote_processing'='false')
        OR EXISTS(SELECT 1 FROM sources ps JOIN fragments pf ON pf.version_id=ps.current_version_id JOIN fragment_projects fp ON fp.fragment_id=pf.id
          JOIN entities project ON project.id=fp.project_id WHERE ps.entity_id=meeting.id AND project.data->>'remote_processing'='false'))))
    AND (EXISTS(SELECT 1 FROM links l WHERE l.from_id=ANY($1::uuid[]) AND l.to_id=e.id AND l.type='participant')
      OR EXISTS(SELECT 1 FROM identities i WHERE i.person_id=e.id AND i.provider=$3 AND i.account=$4)) ORDER BY e.id LIMIT 500`,
    [related.map(r => r.id), remote, source.provider, source.account])
  const candidates = new Map<string, Candidate>()
  const add = (email: unknown, name: string, kind: string, entityId: string) => {
    if (typeof email !== 'string' || !z.email().safeParse(email).success) return
    const normalized = email.toLowerCase(), c = candidates.get(normalized) ?? { id: hash(normalized), email: normalized, names: [], origins: [] }
    if (name && !c.names.includes(name)) c.names.push(name)
    if (!c.origins.some(o => o.kind === kind && o.entity_id === entityId)) c.origins.push({ kind, entity_id: entityId })
    candidates.set(normalized, c)
  }
  for (const p of people) if (p.data.email_status !== 'inferred') add(p.data.email, p.title, 'known_person', p.id)
  for (const event of related.filter(r => r.kind === 'event')) for (const a of event.data.attendees ?? []) add(a.email, a.displayName ?? '', 'calendar_invitee', event.id)
  const speakers = await store.db.query(`SELECT DISTINCT p.id,p.title,p.data FROM fragments f JOIN entities p ON p.id=f.speaker_id
    WHERE f.version_id=$1 AND NULLIF(p.data->>'email','') IS NULL AND p.data->>'merged_into' IS NULL AND COALESCE(p.data->>'manual_email','false')<>'true' ORDER BY p.id`, [source.current_version_id])
  const fragments = await store.db.query('SELECT id,text,speaker_id,ordinal FROM fragments WHERE version_id=$1 ORDER BY ordinal', [source.current_version_id])
  return { speakers, candidates: [...candidates.values()].sort((a, b) => a.email.localeCompare(b.email)), fragments,
    meetings: related.map(r => ({ id: r.id, title: r.title, kind: r.kind })) }
}

export async function inferIdentities(store: MemoryStore, ai: MemoryAI, source: Record<string, any>, remote: boolean,
  model: string, progress: (value: Record<string, unknown>) => Promise<void>, signal: AbortSignal, autoMerge = false) {
  const context = await identityContext(store, source, remote)
  const key = hash({ version: source.current_version_id, speakers: context.speakers.map(p => ({ id: p.id, title: p.title })), candidates: context.candidates, model })
  const previous = (await store.db.query("SELECT metadata->>'identity_inference_key' AS key FROM versions WHERE id=$1", [source.current_version_id]))[0]?.key
  const totals = { identity_suggestions: 0, identity_rejected: 0, identity_auto_applied: 0, identity_input_tokens: 0, identity_output_tokens: 0 }
  if (!context.speakers.length || !context.candidates.length || previous === key) return totals
  const batches = Math.ceil(context.speakers.length / 8)
  await progress({ stage: 'identity_inference', identity_batches: batches, identity_batch: 0, ...totals })
  for (let i = 0; i < context.speakers.length; i += 8) {
    signal.throwIfAborted()
    const speakers = context.speakers.slice(i, i + 8), indices = new Set<number>()
    // Include the beginning plus samples and neighbours, so address-by-name and introductions remain visible.
    context.fragments.slice(0, 12).forEach((_, index) => indices.add(index))
    for (const speaker of speakers) {
      const indicesForSpeaker = context.fragments.flatMap((f, index) => f.speaker_id === speaker.id ? [index] : [])
      for (let n = 0; n < Math.min(8, indicesForSpeaker.length); n++) {
        const index = indicesForSpeaker[Math.floor(n * indicesForSpeaker.length / Math.min(8, indicesForSpeaker.length))]!
        for (const neighbour of [index - 1, index, index + 1]) if (neighbour >= 0 && neighbour < context.fragments.length) indices.add(neighbour)
      }
    }
    const fragments = [...indices].sort((a, b) => a - b).map(index => { const f = context.fragments[index]!; return { id: f.id, speaker_id: f.speaker_id, ordinal: f.ordinal, text: f.text.slice(0, 800) } })
    // LLMs copy short references more reliably than UUIDs. Resolve them locally after validation.
    const speakerRefs = new Map(speakers.map((p, index) => [`s${index + 1}`, p.id as string]))
    const candidateRefs = new Map(context.candidates.map((c, index) => [`c${index + 1}`, c.id]))
    const evidenceRefs = new Map(fragments.map((f, index) => [`f${index + 1}`, f.id as string]))
    await progress({ stage: 'identity_inference', identity_current_batch: Math.floor(i / 8) + 1, request_started_at: new Date().toISOString() })
    let malformed = 0
    const result = await ai.extract(`Proponé asociaciones entre hablantes sin email y candidatos conocidos. Elegí exclusivamente candidate_id de la entrada.
      Usá nombres, alias, presentaciones y contexto para inferir, sin tratar la inferencia como identidad confirmada. Los invitados de Calendar pueden no haber asistido.
      Un nombre parecido, el dominio o la eliminación de otros invitados por sí solos no bastan para confianza alta. Considerá homónimos, bots y salas compartidas.
      Si hay varias opciones plausibles, bajá la confianza o abstenete. Una propuesta por hablante; citá al menos una intervención de ese hablante y explicá la evidencia y las dudas.
      Copiá literalmente speaker_id s1/s2/etc, candidate_id c1/c2/etc y evidence_ids f1/f2/etc de la entrada. Si un hablante no tiene candidato, omitilo en lugar de devolver null.
      En reason usá nombres y correos legibles, sin códigos s1/c1/f1.
      La confianza alta se aplica automáticamente sin revisión humana: reservala para evidencia directa (se presenta con ese nombre, lo nombran así, o el candidato es una persona conocida con el mismo nombre completo).
      No inventes correos ni personas. Las propuestas existentes, confirmadas o descartadas no son prueba de identidad.`,
    { title: source.title, meetings: context.meetings,
      speakers: speakers.map((p, index) => ({ id: `s${index + 1}`, name: p.title })),
      candidates: context.candidates.map((c, index) => ({ ...c, id: `c${index + 1}` })),
      fragments: fragments.map((f, index) => ({ ...f, id: `f${index + 1}`, speaker_id: [...speakerRefs].find(([, id]) => id === f.speaker_id)?.[0] ?? 'other' })) },
    responseSchema, raw => raw as z.infer<typeof responseSchema>)
    signal.throwIfAborted()
    // Validate item by item here rather than in the transport, so a single malformed entry costs one proposal, not the batch.
    const matches = lenientItems(result.value, 'matches', matchSchema, () => { malformed++ })
    const seen = new Set<string>(), valid: Match[] = []
    totals.identity_rejected += malformed
    for (const raw of matches) {
      if (raw.candidate_id === null) continue // an explicit abstention is not an error
      const speaker = speakerRefs.get(raw.speaker_id), candidate = candidateRefs.get(raw.candidate_id), evidence = raw.evidence_ids.map(id => evidenceRefs.get(id))
      if (!speaker || !candidate || seen.has(speaker) || evidence.some(id => !id)
        || !evidence.some(id => fragments.some(f => f.id === id && f.speaker_id === speaker))) { totals.identity_rejected++; continue }
      seen.add(speaker)
      valid.push({ ...raw, speaker_id: speaker, candidate_id: candidate, evidence_ids: evidence as string[] })
    }
    totals.identity_input_tokens += result.usage.input_tokens; totals.identity_output_tokens += result.usage.output_tokens
    await store.db.transaction(async sql => {
      // Serialize proposal writes and check source freshness after the network call.
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`identity-inference:${source.entity_id}`])
      check((await sql.query('SELECT current_version_id FROM sources WHERE id=$1', [source.id]))[0]?.current_version_id === source.current_version_id, 'La fuente cambió; volvé a inferir sus identidades', 409)
      for (const match of valid) {
        const person = await requireEntity(sql, match.speaker_id, 'person')
        if (person.data.email || person.data.manual_email || person.data.merged_into) continue
        const candidate = context.candidates.find(c => c.id === match.candidate_id)!
        const dedupe = hash({ category: 'identity_match', person: person.id, email: candidate.email, version: source.current_version_id })
        if ((await sql.query(`SELECT id FROM entities WHERE kind='fact' AND data->>'category'='identity_match' AND (data->>'dedupe_key'=$1
          OR (data->>'speaker_id'=$2 AND data->'candidate'->>'email'=$3 AND data->>'review_state' IN ('accepted','rejected')))`, [dedupe, person.id, candidate.email])).length) continue
        const factId = randomUUID(), text = `${person.title} → ${candidate.email}`
        const reason = match.reason.replace(/\b([scf]\d+)\b/g, ref => {
          const speakerId = speakerRefs.get(ref), candidateId = candidateRefs.get(ref), evidenceId = evidenceRefs.get(ref)
          if (speakerId) return speakers.find(s => s.id === speakerId)!.title as string
          if (candidateId) return context.candidates.find(c => c.id === candidateId)!.email
          if (evidenceId) return `fragmento #${Number(fragments.find(f => f.id === evidenceId)!.ordinal) + 1}`
          return ref
        })
        await sql.query("INSERT INTO entities(id,kind,title,data) VALUES($1,'fact',$2,$3)", [factId, text.slice(0, 500), JSON.stringify({
          category: 'identity_match', text, speaker_id: person.id, speaker_name: person.title, candidate,
          confidence: match.confidence, reason, review_state: 'pending', identity_status: 'inferred',
          source_version: source.current_version_id, model: result.usage.model, prompt_version: 'identity-v2', dedupe_key: dedupe, stale: false })])
        for (const evidence of new Set(match.evidence_ids)) await sql.query('INSERT INTO evidence VALUES($1,$2)', [factId, evidence])
        for (const [target, type] of [[source.entity_id, 'derived_from'], [person.id, 'identity_subject']]) await sql.query('INSERT INTO links(id,from_id,to_id,type) VALUES($1,$2,$3,$4)', [randomUUID(), factId, target, type])
        await sql.query("INSERT INTO changes(entity_id,action,actor,after_value) VALUES($1,'identity.proposed','ai',$2)", [person.id, JSON.stringify({ proposal_id: factId, email: candidate.email, confidence: match.confidence })])
        totals.identity_suggestions++
        if (autoMerge && match.confidence === 'high' && await autoApplyIdentity(sql, factId)) totals.identity_auto_applied++
      }
    })
    await progress({ identity_batch: Math.floor(i / 8) + 1, ...totals })
  }
  if (!totals.identity_rejected) await store.db.query("UPDATE versions SET metadata=metadata || jsonb_build_object('identity_inference_key',$2::text) WHERE id=$1", [source.current_version_id, key])
  return totals
}

/** Applies a high-confidence proposal inside a savepoint: a failed guard leaves it pending with the reason recorded. */
export async function autoApplyIdentity(sql: Sql, proposalId: string): Promise<boolean> {
  await sql.query('SAVEPOINT identity_auto_apply')
  try {
    await applyIdentityDecision(sql, proposalId, 'accepted', 'ai:auto', true)
    await sql.query('RELEASE SAVEPOINT identity_auto_apply')
    return true
  } catch (error) {
    await sql.query('ROLLBACK TO SAVEPOINT identity_auto_apply')
    if (!(error instanceof MemoryError)) throw error
    await sql.query("UPDATE entities SET data=data || jsonb_build_object('auto_apply_blocked',$2::text),updated_at=now() WHERE id=$1", [proposalId, error.message])
    return false
  }
}

export async function reviewIdentity(store: MemoryStore, proposalId: string, decision: 'accepted' | 'rejected', actor: string) {
  return store.db.transaction(sql => applyIdentityDecision(sql, proposalId, decision, actor, false))
}

async function candidateStillExists(sql: Sql, origins: { kind: string; entity_id: string }[], email: string): Promise<boolean> {
  for (const origin of origins) {
    let current = (await sql.query<Entity>('SELECT id,kind,data FROM entities WHERE id=$1', [origin.entity_id]))[0]
    for (let hops = 0; current?.kind === 'person' && current.data.merged_into && hops < 20; hops++) current = (await sql.query<Entity>('SELECT id,kind,data FROM entities WHERE id=$1', [current.data.merged_into]))[0]
    if (origin.kind === 'known_person' && current?.kind === 'person' && current.data.email?.toLowerCase() === email) return true
    if (origin.kind === 'calendar_invitee' && current?.kind === 'event' && current.data.attendees?.some((a: any) => a.email?.toLowerCase() === email)) return true
  }
  return false
}

/**
 * Accepting means "this speaker is that email". When the email already belongs to a known profile the speaker is folded into it,
 * so a confirmation never leaves two active people with the same verified email.
 */
export async function applyIdentityDecision(sql: Sql, proposalId: string, decision: 'accepted' | 'rejected', actor: string, automatic: boolean) {
  await sql.query('SELECT id FROM entities WHERE id=$1 FOR UPDATE', [proposalId])
  const proposal = await requireEntity(sql, proposalId, 'fact'), p = proposal.data
  check(p.category === 'identity_match', 'La propuesta no corresponde a una identidad')
  if (p.review_state === decision) return { reviewed: true, person_id: p.speaker_id as string }
  check(p.review_state === 'pending', 'La propuesta ya fue revisada', 409)
  let personId = p.speaker_id as string, mergedInto: string | null = null
  if (decision === 'accepted') {
    check(!p.stale, 'La evidencia cambió; revisá la versión actual antes de confirmar', 409)
    check((await sql.query('SELECT 1 FROM sources WHERE current_version_id=$1', [p.source_version])).length, 'La propuesta corresponde a una versión histórica', 409)
    await sql.query('SELECT id FROM entities WHERE id=$1 FOR UPDATE', [p.speaker_id])
    const person = await requireEntity(sql, p.speaker_id, 'person'), email = parse(z.email(), p.candidate.email).toLowerCase()
    check(!person.data.merged_into && (!person.data.email || person.data.email === email) && !person.data.manual_email, 'La identidad fue corregida; recargá antes de aplicar otra propuesta', 409)
    check((await sql.query('SELECT 1 FROM evidence ev JOIN fragments f ON f.id=ev.fragment_id WHERE ev.entity_id=$1 AND f.speaker_id=$2', [proposalId, person.id])).length, 'El hablante de la evidencia fue corregido; la propuesta debe revisarse', 409)
    check(await candidateStillExists(sql, p.candidate.origins ?? [], email), 'El correo candidato cambió o ya no existe en las fuentes', 409)
    const known = await sql.query<Entity>(`SELECT * FROM entities WHERE kind='person' AND id<>$1 AND lower(data->>'email')=$2 AND data->>'merged_into' IS NULL AND COALESCE(data->>'email_status','')<>'inferred' ORDER BY id`, [person.id, email])
    if (automatic) for (const other of known) check(namesCompatible(person.title, other.title), `Los nombres «${person.title}» y «${other.title}» no coinciden; requiere revisión humana`, 409)
    const data = { ...person.data, email, email_status: 'verified', identity_status: 'verified', confirmed_proposal: proposalId,
      ...(automatic ? { manual_email: false, email_source: 'ai_auto_confirmed' } : { manual_email: true, email_source: 'manual_confirmation_of_ai', identity_verified: true }) }
    await sql.query('UPDATE entities SET data=$2,updated_at=now() WHERE id=$1', [person.id, JSON.stringify(data)])
    await sql.query('UPDATE identities SET email=$2 WHERE person_id=$1', [person.id, email])
    await sql.query("INSERT INTO changes(entity_id,action,actor,before_value,after_value) VALUES($1,'identity.confirmed',$2,$3,$4)", [person.id, actor, JSON.stringify(person.data), JSON.stringify(data)])
    const unified = await unifyByEmail(sql, person.id, actor, { reason: automatic ? 'ai_high_confidence' : 'identity_confirmed', force: !automatic })
    if (unified.person_id !== person.id) { personId = unified.person_id; mergedInto = unified.person_id }
  }
  const applied = decision === 'accepted' ? (mergedInto ? 'merged' : 'email') : null
  await sql.query("UPDATE entities SET data=data || jsonb_build_object('review_state',$2::text,'reviewed_by',$3::text,'applied',$4::text),updated_at=now() WHERE id=$1", [proposalId, decision, actor, applied])
  await sql.query("INSERT INTO changes(entity_id,action,actor,after_value) VALUES($1,'identity.reviewed',$2,$3)", [proposalId, actor, JSON.stringify({ decision, automatic, applied, merged_into: mergedInto })])
  return { reviewed: true, person_id: personId, ...(mergedInto ? { merged_into: mergedInto } : {}) }
}
