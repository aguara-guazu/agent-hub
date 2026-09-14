import { randomUUID } from 'node:crypto'
import type { Sql } from './database.js'
import type { Entity } from './contracts.js'
import { check } from './contracts.js'
import { hash, requireEntity } from './store.js'

/** Identity unification shared by manual review, provider sync, automatic inference and the dedupe job. */

const PLACEHOLDER_NAMES = new Set(['participante sin identificar', 'sin identificar', 'unknown', 'desconocido', 'anonimo', 'anonymous'])
export function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}
export function nameTokens(value: string): string[] { return normalizeName(value).split(' ').filter(t => t.length >= 2) }
export function isPlaceholderName(value: string): boolean { const n = normalizeName(value); return !n || PLACEHOLDER_NAMES.has(n) }
function emailTokens(email: string | null | undefined): string[] {
  return email ? (email.split('@')[0] ?? '').split(/[._\-+0-9]+/).filter(t => t.length >= 3) : []
}

/** A shared email plus compatible names is one person; a shared email with unrelated names is a conflict to review, never a silent merge. */
export function namesCompatible(a: string, b: string): boolean {
  if (isPlaceholderName(a) || isPlaceholderName(b)) return true
  const ta = nameTokens(a), tb = nameTokens(b)
  if (!ta.length || !tb.length) return true
  const sa = new Set(ta), sb = new Set(tb)
  if (ta.every(t => sb.has(t)) || tb.every(t => sa.has(t))) return true
  const shared = ta.filter(t => sb.has(t))
  return shared.length >= 2 || (shared.length >= 1 && (ta[0] === tb[0] || ta.at(-1) === tb.at(-1)))
}
/** Related enough to ask the model. Deliberately broader than namesCompatible; the model and the guards decide. */
export function namesRelated(a: { title: string; email?: string | null }, b: { title: string; email?: string | null }): boolean {
  const ta = new Set([...nameTokens(a.title), ...emailTokens(a.email)]), tb = new Set([...nameTokens(b.title), ...emailTokens(b.email)])
  if (!ta.size || !tb.size) return false
  const shared = [...ta].filter(t => tb.has(t))
  if (!shared.length) return false
  if ([...ta].every(t => tb.has(t)) || [...tb].every(t => ta.has(t))) return true
  return shared.length >= 2 || (shared.some(t => t.length >= 4) && (nameTokens(a.title).length === 1 || nameTokens(b.title).length === 1))
}

/** Follows merged_into so callers always land on the active profile. */
export async function resolveCanonical(sql: Sql, personId: string): Promise<Entity> {
  let person = await requireEntity(sql, personId, 'person')
  for (let hops = 0; person.data.merged_into && hops < 20; hops++) person = await requireEntity(sql, String(person.data.merged_into), 'person')
  check(!person.data.merged_into, 'La cadena de unificaciones es demasiado larga', 409)
  return person
}

/**
 * Prefers provider-anchored profiles: a stable Google user ID and a People-verified email beat a label copied from a document.
 * `newcomer` is the profile that just acquired the shared email; on equal footing the existing owner of the email survives.
 */
export async function choosePrimary(sql: Sql, people: Entity[], newcomer?: string): Promise<Entity> {
  const ids = people.map(p => p.id)
  const identities = await sql.query('SELECT person_id,external_id,verified FROM identities WHERE person_id=ANY($1::uuid[])', [ids])
  const fragments = new Map((await sql.query('SELECT speaker_id,count(*)::int AS n FROM fragments WHERE speaker_id=ANY($1::uuid[]) GROUP BY 1', [ids])).map(r => [r.speaker_id, r.n as number]))
  const score = (p: Entity) => {
    const own = identities.filter(i => i.person_id === p.id)
    return (own.some(i => /^users\//.test(i.external_id)) ? 8 : 0) + (String(p.data.email_source ?? '').startsWith('google_people:') ? 4 : 0)
      + (p.data.identity_verified ? 2 : 0) + (p.data.manual_email ? 1 : 0) + (own.some(i => i.verified) ? 1 : 0) + (isPlaceholderName(p.title) ? -4 : 0) + (p.id === newcomer ? -3 : 0)
  }
  return [...people].sort((a, b) => score(b) - score(a) || (fragments.get(b.id) ?? 0) - (fragments.get(a.id) ?? 0) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0]!
}

export async function mergePeople(sql: Sql, fromId: string, intoId: string, actor: string, reason = 'manual') {
  check(fromId !== intoId, 'Elegí dos personas distintas')
  await sql.query('SELECT id FROM entities WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[fromId, intoId]])
  const source = await requireEntity(sql, fromId, 'person'), target = await requireEntity(sql, intoId, 'person')
  check(!source.data.merged_into, 'La persona ya fue unificada con otra identidad', 409)
  check(!target.data.merged_into, 'La persona destino ya fue unificada; elegí la identidad vigente', 409)
  await sql.query('UPDATE identities SET person_id=$2 WHERE person_id=$1', [fromId, intoId])
  await sql.query('UPDATE fragments SET speaker_id=$2 WHERE speaker_id=$1', [fromId, intoId])
  await sql.query('UPDATE rules SET person_id=$2 WHERE person_id=$1', [fromId, intoId])
  const links = await sql.query('SELECT * FROM links WHERE from_id=$1 OR to_id=$1', [fromId])
  for (const link of links) {
    const a = link.from_id === fromId ? intoId : link.from_id, b = link.to_id === fromId ? intoId : link.to_id
    if (a !== b) await sql.query('INSERT INTO links(id,from_id,to_id,type,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [randomUUID(), a, b, link.type, JSON.stringify(link.data)])
  }
  await sql.query('DELETE FROM links WHERE from_id=$1 OR to_id=$1', [fromId])
  // Collection rows of type entity keep pointing at a living profile.
  await sql.query(`UPDATE collection_records SET values=replace(values::text,$1,$2)::jsonb,updated_at=now() WHERE values::text LIKE '%' || $1 || '%'`, [`"${fromId}"`, `"${intoId}"`])
  const data: Record<string, any> = { ...target.data }
  if (!data.email && source.data.email) Object.assign(data, { email: source.data.email, email_status: source.data.email_status ?? 'verified', email_source: source.data.email_source ?? null, manual_email: Boolean(source.data.manual_email) })
  const candidates = new Set<string>([...(data.email_candidates ?? []), ...(source.data.email_candidates ?? [])].filter(c => typeof c === 'string'))
  if (candidates.size) data.email_candidates = [...candidates]
  if (source.data.identity_verified) data.identity_verified = true
  if (data.identity_status !== 'verified' && (source.data.identity_status === 'verified' || data.email)) data.identity_status = 'verified'
  if (data.identity_status === undefined) data.identity_status = data.email ? 'verified' : 'unresolved'
  data.merged_from = [...new Set<string>([...(data.merged_from ?? []), fromId, ...(source.data.merged_from ?? [])])]
  const title = isPlaceholderName(target.title) && !isPlaceholderName(source.title) ? source.title : target.title
  await sql.query('UPDATE entities SET title=$2,data=$3,updated_at=now() WHERE id=$1', [intoId, title, JSON.stringify(data)])
  await sql.query(`UPDATE entities SET data=data || jsonb_build_object('merged_into',$2::text,'identity_status','merged','merged_at',now(),'merge_reason',$3::text,'merged_by',$4::text),updated_at=now() WHERE id=$1`, [fromId, intoId, reason, actor])
  // Profiles absorbed earlier by `from` point straight at the survivor, so no reader has to walk a chain.
  await sql.query(`UPDATE entities SET data=data || jsonb_build_object('merged_into',$2::text),updated_at=now() WHERE kind='person' AND data->>'merged_into'=$1`, [fromId, intoId])
  await repointIdentityProposals(sql, fromId, intoId, data.email)
  await sql.query(`UPDATE entities SET data=data || jsonb_build_object('review_state','accepted','reviewed_by',$3::text,'applied','merged'),updated_at=now()
    WHERE kind='fact' AND data->>'category'='person_duplicate' AND data->>'review_state'='pending'
    AND ((data->>'from_id'=$1 AND data->>'into_id'=$2) OR (data->>'from_id'=$2 AND data->>'into_id'=$1))`, [fromId, intoId, actor])
  for (const column of ['from_id', 'into_id']) await sql.query(`UPDATE entities SET data=data || jsonb_build_object($3::text,$2::text),updated_at=now()
    WHERE kind='fact' AND data->>'category'='person_duplicate' AND data->>'review_state'='pending' AND data->>$3=$1`, [fromId, intoId, column])
  await sql.query(`UPDATE entities SET data=data || '{"review_state":"accepted","reviewed_by":"system:merge","applied":"merged"}'::jsonb,updated_at=now()
    WHERE kind='fact' AND data->>'category'='person_duplicate' AND data->>'review_state'='pending' AND data->>'from_id'=data->>'into_id'`)
  const detail = { from_id: fromId, from_title: source.title, from_email: source.data.email ?? null, into_id: intoId, into_title: title, reason }
  await sql.query("INSERT INTO changes(entity_id,action,actor,before_value,after_value) VALUES($1,'person.merged',$2,$3,$4)", [intoId, actor, JSON.stringify({ from_id: fromId, from_title: source.title }), JSON.stringify(detail)])
  await sql.query("INSERT INTO changes(entity_id,action,actor,before_value,after_value) VALUES($1,'person.merged_into',$2,$3,$4)", [fromId, actor, JSON.stringify(source.data), JSON.stringify(detail)])
  return { merged: true as const, person_id: intoId, from_id: fromId }
}

/** Proposals about an absorbed speaker now describe the surviving profile; if it already has an email they are settled. */
export async function repointIdentityProposals(sql: Sql, fromId: string, intoId: string, email: unknown) {
  await sql.query(`UPDATE entities SET data=data || jsonb_build_object('speaker_id',$2::text,'original_speaker_id',COALESCE(data->>'original_speaker_id',$1::text)),updated_at=now()
    WHERE kind='fact' AND data->>'category'='identity_match' AND data->>'speaker_id'=$1`, [fromId, intoId])
  if (typeof email === 'string' && email) await sql.query(`UPDATE entities SET data=data || jsonb_build_object('review_state',CASE WHEN lower(data->'candidate'->>'email')=$2 THEN 'accepted' ELSE 'rejected' END,'reviewed_by','system:merge','applied','merged'),updated_at=now()
    WHERE kind='fact' AND data->>'category'='identity_match' AND data->>'speaker_id'=$1 AND data->>'review_state'='pending'`, [intoId, email.toLowerCase()])
}
/** Settles proposals overtaken by events: the speaker was merged elsewhere, or already carries the proposed email. */
export async function settleIdentityProposals(sql: Sql): Promise<number> {
  const rows = await sql.query(`SELECT DISTINCT s.id AS from_id FROM entities p JOIN entities s ON s.id=(p.data->>'speaker_id')::uuid
    WHERE p.kind='fact' AND p.data->>'category'='identity_match' AND p.data->>'review_state'='pending' AND s.data->>'merged_into' IS NOT NULL`)
  for (const row of rows) { const into = await resolveCanonical(sql, row.from_id); await repointIdentityProposals(sql, row.from_id, into.id, into.data.email) }
  const settled = await sql.query(`UPDATE entities p SET data=p.data || '{"review_state":"accepted","reviewed_by":"system:settled","applied":"already_had_email"}'::jsonb,updated_at=now()
    FROM entities s WHERE p.kind='fact' AND p.data->>'category'='identity_match' AND p.data->>'review_state'='pending'
    AND s.id=(p.data->>'speaker_id')::uuid AND lower(s.data->>'email')=lower(p.data->'candidate'->>'email') RETURNING p.id`)
  return rows.length + settled.length
}

export interface DuplicateProposalInput {
  from: Entity; into: Entity; basis: 'ai' | 'same_email'; verdict: 'same' | 'different' | 'conflict'
  confidence: 'high' | 'medium' | 'low'; reason: string; dedupe_key: string; review_state: 'pending' | 'accepted' | 'rejected'
  reviewed_by?: string; model?: string; blocked?: string; applied?: string; applied_rule?: string; evidence_ids?: string[]; signals?: Record<string, unknown>
}
export async function recordDuplicateProposal(sql: Sql, input: DuplicateProposalInput): Promise<string | null> {
  const existing = await sql.query("SELECT id FROM entities WHERE kind='fact' AND data->>'category'='person_duplicate' AND data->>'dedupe_key'=$1", [input.dedupe_key])
  if (existing.length) return null
  const factId = randomUUID(), text = `${input.from.title} ≈ ${input.into.title}`
  await sql.query("INSERT INTO entities(id,kind,title,data) VALUES($1,'fact',$2,$3)", [factId, text.slice(0, 500), JSON.stringify({
    category: 'person_duplicate', text, from_id: input.from.id, into_id: input.into.id, from_name: input.from.title, into_name: input.into.title,
    from_email: input.from.data.email ?? null, into_email: input.into.data.email ?? null, basis: input.basis, verdict: input.verdict, confidence: input.confidence,
    reason: input.reason.slice(0, 1600), review_state: input.review_state, ...(input.reviewed_by ? { reviewed_by: input.reviewed_by } : {}), ...(input.model ? { model: input.model } : {}),
    ...(input.blocked ? { blocked: input.blocked } : {}), ...(input.applied ? { applied: input.applied } : {}), ...(input.applied_rule ? { applied_rule: input.applied_rule } : {}), ...(input.signals ? { signals: input.signals } : {}),
    prompt_version: 'dedupe-v1', dedupe_key: input.dedupe_key, stale: false })])
  for (const evidence of new Set(input.evidence_ids ?? [])) await sql.query('INSERT INTO evidence VALUES($1,$2) ON CONFLICT DO NOTHING', [factId, evidence])
  for (const target of new Set([input.from.id, input.into.id])) await sql.query("INSERT INTO links(id,from_id,to_id,type) VALUES($1,$2,$3,'identity_subject') ON CONFLICT DO NOTHING", [randomUUID(), factId, target])
  await sql.query("INSERT INTO changes(entity_id,action,actor,after_value) VALUES($1,'duplicate.proposed',$2,$3)", [input.into.id, input.reviewed_by ?? 'ai', JSON.stringify({ proposal_id: factId, from_id: input.from.id, verdict: input.verdict, confidence: input.confidence })])
  return factId
}

/**
 * Every active profile sharing this person's verified email is folded into one primary profile.
 * `force` is for an explicit human confirmation of this exact association; otherwise unrelated names become a review conflict.
 */
export async function unifyByEmail(sql: Sql, personId: string, actor: string, options: { reason: string; force?: boolean }) {
  const person = await requireEntity(sql, personId, 'person')
  const email = typeof person.data.email === 'string' ? person.data.email.toLowerCase() : ''
  if (!email || person.data.merged_into) return { person_id: personId, merged: [] as string[], conflicts: [] as string[] }
  const group = await sql.query<Entity>(`SELECT * FROM entities WHERE kind='person' AND lower(data->>'email')=$1 AND data->>'merged_into' IS NULL
    AND COALESCE(data->>'email_status','') <> 'inferred' ORDER BY id FOR UPDATE`, [email])
  if (group.length < 2) return { person_id: personId, merged: [] as string[], conflicts: [] as string[] }
  const primary = await choosePrimary(sql, group, personId), merged: string[] = [], conflicts: string[] = []
  for (const other of group) {
    if (other.id === primary.id) continue
    if (options.force || namesCompatible(other.title, primary.title)) { await mergePeople(sql, other.id, primary.id, actor, options.reason); merged.push(other.id); continue }
    const key = hash({ basis: 'same_email', from: other.id, into: primary.id, email, names: [other.title, primary.title] })
    const rejected = await sql.query(`SELECT 1 FROM entities WHERE kind='fact' AND data->>'category'='person_duplicate' AND data->>'review_state'='rejected' AND COALESCE(data->>'reviewed_by','ai') NOT LIKE 'ai%'
      AND ((data->>'from_id'=$1 AND data->>'into_id'=$2) OR (data->>'from_id'=$2 AND data->>'into_id'=$1))`, [other.id, primary.id])
    if (!rejected.length) await recordDuplicateProposal(sql, { from: other, into: primary, basis: 'same_email', verdict: 'conflict', confidence: 'low', dedupe_key: key, review_state: 'pending',
      reason: `Comparten el email ${email}, pero los nombres «${other.title}» y «${primary.title}» no coinciden. Revisá si es la misma persona o si uno de los correos está mal asignado.` })
    conflicts.push(other.id)
  }
  return { person_id: primary.id, merged, conflicts }
}
