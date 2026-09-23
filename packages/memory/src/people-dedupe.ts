import { z } from 'zod'
import { lenientItems, type MemoryAI } from './ai.js'
import { usesRemoteExtraction, type AIConfig } from './config.js'
import type { Entity } from './contracts.js'
import type { Sql } from './database.js'
import type { MemoryStore } from './store.js'
import { hash, requireEntity } from './store.js'
import { autoApplyIdentity } from './identity-inference.js'
import { choosePrimary, mergePeople, nameTokens, namesRelated, normalizeName, recordDuplicateProposal, settleIdentityProposals, unifyByEmail } from './people.js'

const verdictSchema = z.object({
  pair_id: z.string().max(20), same: z.boolean(), confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string().min(1).max(1600), evidence_ids: z.array(z.string().max(20)).max(8).default([]),
}).strict()
const responseSchema = z.object({ pairs: z.array(verdictSchema).max(40) }).strict()

type Sample = { id: string; text: string; source_title: string; occurred_at: string | null }
interface Profile { entity: Entity; identity_kinds: string[]; fragments_total: number; meetings: { title: string; kind: string; occurred_at: string | null }[]; samples: Sample[] }
interface Pair { a: Profile; b: Profile; signals: { both_speak_in_same_transcript: boolean; appear_in_linked_sources: boolean; same_normalized_name: boolean }; key: string }

// Remote providers only see people and fragments whose sources and projects allow remote processing.
const sourcePermitted = (alias: string, remote: string) => `(NOT ${remote}::boolean OR (COALESCE(${alias}.data->>'remote_processing','true')<>'false'
  AND NOT EXISTS(SELECT 1 FROM links pl JOIN entities project ON project.id=pl.to_id WHERE pl.from_id=${alias}.id AND pl.type='project' AND project.data->>'remote_processing'='false')
  AND NOT EXISTS(SELECT 1 FROM sources ps JOIN fragments pf ON pf.version_id=ps.current_version_id JOIN fragment_projects fp ON fp.fragment_id=pf.id
    JOIN entities project ON project.id=fp.project_id WHERE ps.entity_id=${alias}.id AND project.data->>'remote_processing'='false')))`
const personPermitted = (alias: string, remote: string) => `(NOT ${remote}::boolean OR (COALESCE(${alias}.data->>'remote_processing','true')<>'false'
  AND NOT EXISTS(SELECT 1 FROM links membership JOIN entities meeting ON meeting.id=membership.from_id WHERE membership.to_id=${alias}.id AND membership.type='participant' AND NOT ${sourcePermitted('meeting', remote)})))`

function identityKind(externalId: string): string {
  if (/^users\//.test(externalId)) return 'meet_user'
  if (/:speaker:/.test(externalId)) return 'docs_label'
  if (/^conferenceRecords\//.test(externalId) || /anonymous/i.test(externalId)) return 'meet_anonymous'
  return 'other'
}
function emailSourceKind(data: Record<string, any>): string {
  if (!data.email) return 'none'
  const source = String(data.email_source ?? '')
  if (source.startsWith('google_people:')) return 'provider_verified'
  if (source === 'manual' || source === 'manual_confirmation_of_ai') return 'human_confirmed'
  if (source === 'ai_auto_confirmed') return 'ai_inferred'
  return data.identity_verified ? 'provider_verified' : 'registered'
}

async function loadProfile(sql: Sql, entity: Entity, remote: boolean): Promise<Profile> {
  const identities = await sql.query('SELECT external_id FROM identities WHERE person_id=$1', [entity.id])
  const [count] = await sql.query('SELECT count(*)::int AS n FROM fragments WHERE speaker_id=$1', [entity.id])
  const meetings = await sql.query(`SELECT DISTINCT e.id,e.title,e.kind,e.data->>'occurred_at' AS occurred_at FROM links l JOIN entities e ON e.id=l.from_id
    WHERE l.to_id=$1 AND l.type='participant' AND ${sourcePermitted('e', '$2')} ORDER BY 4 DESC NULLS LAST,e.id LIMIT 6`, [entity.id, remote])
  const samples = await sql.query<Sample>(`SELECT f.id,f.text,e.title AS source_title,e.data->>'occurred_at' AS occurred_at FROM fragments f JOIN versions v ON v.id=f.version_id
    JOIN sources s ON s.id=v.source_id AND s.current_version_id=v.id JOIN entities e ON e.id=s.entity_id
    WHERE f.speaker_id=$1 AND ${sourcePermitted('e', '$2')} AND NOT EXISTS(SELECT 1 FROM fragment_projects fp JOIN entities project ON project.id=fp.project_id WHERE $2::boolean AND fp.fragment_id=f.id AND project.data->>'remote_processing'='false')
    ORDER BY (f.text ~* '(soy |me llamo|mi nombre|habla |speaking|this is )') DESC,length(f.text) DESC,f.id LIMIT 5`, [entity.id, remote])
  return { entity, identity_kinds: [...new Set(identities.map(i => identityKind(i.external_id)))].sort(), fragments_total: count?.n ?? 0,
    meetings: meetings.map(m => ({ title: m.title, kind: m.kind, occurred_at: m.occurred_at })), samples: samples.map(s => ({ ...s, text: s.text.slice(0, 320) })) }
}

async function identityKinds(sql: Sql, ids: string[]): Promise<Map<string, string[]>> {
  const rows = await sql.query('SELECT person_id,external_id FROM identities WHERE person_id=ANY($1::uuid[])', [ids])
  return new Map(ids.map(id => [id, [...new Set(rows.filter(r => r.person_id === id).map(r => identityKind(r.external_id)))].sort()]))
}
/** Identical full names (two or more tokens) where one side is only a document label without email: a medium "same" from the model is enough. */
export function corroborated(from: Entity, into: Entity, fromKinds: string[], intoKinds: string[]): boolean {
  if (normalizeName(from.title) !== normalizeName(into.title) || nameTokens(from.title).length < 2) return false
  const labelOnly = (entity: Entity, kinds: string[]) => !entity.data.email && kinds.length > 0 && kinds.every(k => k === 'docs_label' || k === 'meet_anonymous')
  return labelOnly(from, fromKinds) || labelOnly(into, intoKinds)
}
type Decision = { from: Entity; into: Entity; blocked?: string; rule?: 'high_confidence' | 'medium_corroborated' }
/** The primary survives; conflicting verified emails or two voices in one transcript block any automatic merge. */
async function decideMerge(sql: Sql, a: Entity, b: Entity, confidence: string, config: AIConfig, sharedTranscript?: boolean): Promise<Decision> {
  const into = await choosePrimary(sql, [a, b]), from = into.id === a.id ? b : a
  const emailA = a.data.email?.toLowerCase(), emailB = b.data.email?.toLowerCase()
  const shared = sharedTranscript ?? (await pairSignals(sql, a, b)).both_speak_in_same_transcript
  const blocked = emailA && emailB && emailA !== emailB ? 'different_verified_emails' : shared ? 'shared_transcript' : !config.identity_auto_merge ? 'auto_merge_disabled' : undefined
  if (blocked) return { from, into, blocked }
  const kinds = await identityKinds(sql, [from.id, into.id])
  if (confidence === 'high') return { from, into, rule: 'high_confidence' }
  if (confidence === 'medium' && corroborated(from, into, kinds.get(from.id) ?? [], kinds.get(into.id) ?? [])) return { from, into, rule: 'medium_corroborated' }
  return { from, into }
}

/** Pending "same" verdicts are re-read on every run: the setting may have changed, or a merge elsewhere may have unblocked or settled them. */
async function reevaluatePending(store: MemoryStore, config: AIConfig): Promise<number> {
  const pending = await store.db.query(`SELECT id FROM entities WHERE kind='fact' AND data->>'category'='person_duplicate' AND data->>'review_state'='pending'
    AND data->>'basis'='ai' AND data->>'verdict'='same' AND data->>'confidence' IN ('high','medium') ORDER BY created_at`)
  let merged = 0
  for (const row of pending) await store.db.transaction(async sql => {
    await sql.query('SELECT id FROM entities WHERE id=$1 FOR UPDATE', [row.id])
    const proposal = await requireEntity(sql, row.id, 'fact')
    if (proposal.data.review_state !== 'pending') return
    const a = await requireEntity(sql, proposal.data.from_id, 'person'), b = await requireEntity(sql, proposal.data.into_id, 'person')
    if (a.data.merged_into || b.data.merged_into) return
    const decision = await decideMerge(sql, a, b, proposal.data.confidence, config)
    if (!decision.rule) {
      if ((decision.blocked ?? null) !== (proposal.data.blocked ?? null)) await sql.query("UPDATE entities SET data=(data - 'blocked') || $2::jsonb,updated_at=now() WHERE id=$1", [row.id, JSON.stringify(decision.blocked ? { blocked: decision.blocked } : {})])
      return
    }
    await mergePeople(sql, decision.from.id, decision.into.id, 'ai:auto', 'ai_high_confidence')
    await sql.query(`UPDATE entities SET data=(data - 'blocked') || jsonb_build_object('review_state','accepted','reviewed_by','ai:auto','applied','merged','applied_rule',$2::text,'from_id',$3::text,'into_id',$4::text,'from_name',$5::text,'into_name',$6::text),updated_at=now() WHERE id=$1`,
      [row.id, decision.rule, decision.from.id, decision.into.id, decision.from.title, decision.into.title])
    merged++
  })
  return merged
}

async function pairSignals(sql: Sql, a: Entity, b: Entity) {
  const shared = await sql.query(`SELECT 1 FROM fragments x JOIN fragments y ON y.version_id=x.version_id JOIN versions v ON v.id=x.version_id
    JOIN sources s ON s.id=v.source_id AND s.current_version_id=v.id WHERE x.speaker_id=$1 AND y.speaker_id=$2 LIMIT 1`, [a.id, b.id])
  const linked = await sql.query(`SELECT 1 FROM fragments x JOIN versions vx ON vx.id=x.version_id JOIN sources sx ON sx.id=vx.source_id
    JOIN links l ON l.type IN ('meeting_document','calendar_event') AND (l.from_id=sx.entity_id OR l.to_id=sx.entity_id)
    JOIN sources sy ON sy.entity_id=CASE WHEN l.from_id=sx.entity_id THEN l.to_id ELSE l.from_id END
    JOIN versions vy ON vy.source_id=sy.id JOIN fragments y ON y.version_id=vy.id AND y.speaker_id=$2 WHERE x.speaker_id=$1 LIMIT 1`, [a.id, b.id])
  return { both_speak_in_same_transcript: shared.length > 0, appear_in_linked_sources: linked.length > 0, same_normalized_name: normalizeName(a.title) === normalizeName(b.title) }
}

/** Pairs a reviewer would consider, minus those already decided by a person or already asked with identical context. */
export async function duplicateCandidates(store: MemoryStore, remote: boolean, model: string, limit = 200): Promise<Pair[]> {
  const people = await store.db.query<Entity>(`SELECT e.* FROM entities e WHERE e.kind='person' AND e.data->>'merged_into' IS NULL AND ${personPermitted('e', '$1')} ORDER BY e.created_at,e.id LIMIT 5000`, [remote])
  const related: [Entity, Entity][] = []
  for (let i = 0; i < people.length; i++) for (let j = i + 1; j < people.length; j++) {
    const a = people[i]!, b = people[j]!
    const emailA = a.data.email?.toLowerCase(), emailB = b.data.email?.toLowerCase()
    if (emailA && emailB && emailA === emailB) continue // handled deterministically or flagged as a conflict
    if (namesRelated({ title: a.title, email: emailA }, { title: b.title, email: emailB })) related.push([a, b])
  }
  related.sort(([a1, b1], [a2, b2]) => Number(normalizeName(a2.title) === normalizeName(b2.title)) - Number(normalizeName(a1.title) === normalizeName(b1.title)))
  const profiles = new Map<string, Profile>(), pairs: Pair[] = []
  for (const [a, b] of related) {
    if (pairs.length >= limit) break
    const previous = await store.db.query(`SELECT data->>'review_state' AS state,COALESCE(data->>'reviewed_by','ai') AS reviewer,data->>'dedupe_key' AS key FROM entities
      WHERE kind='fact' AND data->>'category'='person_duplicate' AND ((data->>'from_id'=$1 AND data->>'into_id'=$2) OR (data->>'from_id'=$2 AND data->>'into_id'=$1))`, [a.id, b.id])
    if (previous.some(p => p.state === 'pending' || (p.state === 'rejected' && !p.reviewer.startsWith('ai')))) continue
    for (const person of [a, b]) if (!profiles.has(person.id)) profiles.set(person.id, await loadProfile(store.db, person, remote))
    const pa = profiles.get(a.id)!, pb = profiles.get(b.id)!
    const signals = await pairSignals(store.db, a, b)
    const key = hash({ pair: [a.id, b.id].sort(), model, names: [a.title, b.title], emails: [a.data.email ?? null, b.data.email ?? null],
      kinds: [pa.identity_kinds, pb.identity_kinds], signals, samples: [pa.samples.map(s => s.id), pb.samples.map(s => s.id)] })
    if (previous.some(p => p.key === key)) continue
    pairs.push({ a: pa, b: pb, signals, key })
  }
  return pairs
}

/**
 * One pass over the whole people base: deterministic email unification, pending high-confidence identity proposals,
 * then the model compares name-related profiles. Only high confidence without conflicting signals merges by itself.
 */
export async function dedupePeople(store: MemoryStore, ai: MemoryAI, config: AIConfig, progress: (value: Record<string, unknown>) => Promise<void>, signal: AbortSignal) {
  const remote = usesRemoteExtraction(config)
  const totals = { dedupe_email_groups: 0, dedupe_email_merged: 0, dedupe_email_conflicts: 0, dedupe_identities_applied: 0, dedupe_pairs: 0,
    dedupe_batches: 0, dedupe_batch: 0, dedupe_auto_merged: 0, dedupe_proposals: 0, dedupe_different: 0, dedupe_rejected: 0, input_tokens: 0, output_tokens: 0 }
  await progress({ stage: 'dedupe_people', provider: config.extraction, model: config.extraction_model, source_title: 'Personas de la memoria', ...totals })
  await store.db.transaction(sql => settleIdentityProposals(sql))
  const groups = await store.db.query(`SELECT lower(data->>'email') AS email,array_agg(id ORDER BY id) AS ids FROM entities WHERE kind='person' AND NULLIF(data->>'email','') IS NOT NULL
    AND data->>'merged_into' IS NULL AND COALESCE(data->>'email_status','')<>'inferred' GROUP BY 1 HAVING count(*)>1`)
  for (const group of groups) {
    signal.throwIfAborted()
    const result = await store.db.transaction(sql => unifyByEmail(sql, group.ids[0], 'system:dedupe', { reason: 'same_verified_email' }))
    totals.dedupe_email_groups++; totals.dedupe_email_merged += result.merged.length; totals.dedupe_email_conflicts += result.conflicts.length
  }
  await progress(totals)
  if (config.identity_auto_merge) {
    const pending = await store.db.query(`SELECT e.id FROM entities e JOIN sources s ON s.current_version_id::text=e.data->>'source_version' WHERE e.kind='fact' AND e.data->>'category'='identity_match'
      AND e.data->>'review_state'='pending' AND e.data->>'confidence'='high' AND COALESCE(e.data->>'stale','false')<>'true' AND e.data->>'auto_apply_blocked' IS NULL ORDER BY e.created_at`)
    for (const row of pending) { signal.throwIfAborted(); if (await store.db.transaction(sql => autoApplyIdentity(sql, row.id))) totals.dedupe_identities_applied++ }
    await progress(totals)
  }
  totals.dedupe_auto_merged += await reevaluatePending(store, config)
  await progress(totals)
  const extractionAllowed = config.extraction !== 'disabled' && (!usesRemoteExtraction(config) || config.remote_processing_enabled)
  if (!extractionAllowed) return { stage: 'complete', ...totals, extraction: config.extraction === 'disabled' ? 'not_configured' : 'disabled_for_source' }
  const pairs = await duplicateCandidates(store, remote, config.extraction_model)
  const size = 6
  totals.dedupe_pairs = pairs.length; totals.dedupe_batches = Math.ceil(pairs.length / size)
  await progress(totals)
  for (let offset = 0; offset < pairs.length; offset += size) {
    signal.throwIfAborted()
    const batch = pairs.slice(offset, offset + size)
    const refs = new Map<string, Pair>(), personRefs = new Map<string, Entity>(), fragmentRefs = new Map<string, Sample>()
    const payload = batch.map((pair, index) => {
      refs.set(`d${index + 1}`, pair)
      const describe = (profile: Profile, side: 'a' | 'b') => {
        const personRef = `p${index * 2 + (side === 'a' ? 1 : 2)}`
        personRefs.set(personRef, profile.entity)
        return { id: personRef, name: profile.entity.title, email: profile.entity.data.email ?? null, email_source: emailSourceKind(profile.entity.data), identity_kinds: profile.identity_kinds,
          fragments_total: profile.fragments_total, meetings: profile.meetings,
          samples: profile.samples.map((sample, n) => { const ref = `f${fragmentRefs.size + n + 1}`; fragmentRefs.set(ref, sample); return { id: ref, source: sample.source_title, date: sample.occurred_at, text: sample.text } }) }
      }
      const a = describe(pair.a, 'a')
      return { pair_id: `d${index + 1}`, a, b: describe(pair.b, 'b'), signals: pair.signals }
    })
    await progress({ dedupe_current_batch: Math.floor(offset / size) + 1, request_started_at: new Date().toISOString() })
    let malformed = 0
    const result = await ai.extract(`Decidí si cada par de perfiles corresponde a la misma persona real. Cada perfil trae nombre, email, origen del email, tipo de identidad
      (meet_user: cuenta de Google en Meet; docs_label: etiqueta de hablante copiada de un documento; meet_anonymous: participante sin cuenta), reuniones, cantidad de intervenciones y muestras.
      Señales calculadas: both_speak_in_same_transcript=true significa que ambos hablan como personas distintas en la misma transcripción y casi seguro son distintos.
      appear_in_linked_sources=true significa que uno habla en un documento vinculado a la reunión donde habla el otro: si además comparten nombre, probablemente es la misma persona registrada dos veces.
      Homónimos existen: un nombre parecido por sí solo no alcanza para confianza alta. Emails verificados distintos pueden ser dos cuentas de la misma persona (por ejemplo dos dominios de la misma empresa), pero eso requiere revisión humana: máximo confianza media.
      Bots, grabadores o notetakers (nombres de servicios, sin intervenciones humanas) no son personas: marcá same=false.
      La confianza alta con same=true se aplica automáticamente sin revisión humana; usala sólo cuando el nombre coincide y el contexto lo respalda.
      Con confianza media, el sistema unifica por su cuenta únicamente si los nombres completos son idénticos y un lado es una etiqueta de documento sin email; en cualquier otro caso una persona revisa.
      Copiá literalmente pair_id d1/d2/etc y evidence_ids f1/f2/etc de la entrada. En reason usá nombres legibles, sin códigos p1/f1, y explicá evidencia y dudas en una o dos frases.`,
    { pairs: payload }, responseSchema, raw => raw as z.infer<typeof responseSchema>)
    signal.throwIfAborted()
    const verdicts = lenientItems(result.value, 'pairs', verdictSchema, () => { malformed++ })
    totals.dedupe_rejected += malformed; totals.input_tokens += result.usage.input_tokens; totals.output_tokens += result.usage.output_tokens
    const seen = new Set<string>()
    for (const verdict of verdicts) {
      const pair = refs.get(verdict.pair_id)
      if (!pair || seen.has(verdict.pair_id)) { totals.dedupe_rejected++; continue }
      seen.add(verdict.pair_id)
      const allowed = new Set([...pair.a.samples, ...pair.b.samples].map(s => s.id))
      const evidence = verdict.evidence_ids.map(ref => fragmentRefs.get(ref)?.id).filter((id): id is string => Boolean(id) && allowed.has(id!))
      const reason = verdict.reason.replace(/\b([pf]\d+)\b/g, ref => personRefs.get(ref)?.title ?? (fragmentRefs.has(ref) ? `una intervención en ${fragmentRefs.get(ref)!.source_title}` : ref))
      await store.db.transaction(async sql => {
        await sql.query('SELECT id FROM entities WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[pair.a.entity.id, pair.b.entity.id]])
        const a = await requireEntity(sql, pair.a.entity.id, 'person'), b = await requireEntity(sql, pair.b.entity.id, 'person')
        if (a.data.merged_into || b.data.merged_into) return
        const decision = await decideMerge(sql, a, b, verdict.confidence, config, pair.signals.both_speak_in_same_transcript)
        const base = { from: decision.from, into: decision.into, basis: 'ai' as const, confidence: verdict.confidence, reason, dedupe_key: pair.key, model: result.usage.model, evidence_ids: evidence, signals: pair.signals }
        if (!verdict.same) { await recordDuplicateProposal(sql, { ...base, verdict: 'different', review_state: 'rejected', reviewed_by: 'ai' }); totals.dedupe_different++; return }
        if (decision.rule) {
          await mergePeople(sql, decision.from.id, decision.into.id, 'ai:auto', 'ai_high_confidence')
          await recordDuplicateProposal(sql, { ...base, verdict: 'same', review_state: 'accepted', reviewed_by: 'ai:auto', applied: 'merged', applied_rule: decision.rule })
          totals.dedupe_auto_merged++; return
        }
        await recordDuplicateProposal(sql, { ...base, verdict: 'same', review_state: 'pending', ...(decision.blocked ? { blocked: decision.blocked } : {}) })
        totals.dedupe_proposals++
      })
    }
    totals.dedupe_batch = Math.floor(offset / size) + 1
    await progress(totals)
  }
  return { stage: 'complete', ...totals, extraction: 'processed' }
}
