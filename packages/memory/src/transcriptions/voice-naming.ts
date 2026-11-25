import { randomUUID } from "node:crypto"
import { z } from "zod"
import { lenientItems, type MemoryAI } from "../ai.js"
import { usesRemoteExtraction, type AIConfig } from "../config.js"
import { check, parse } from "../contracts.js"
import { canonicalName, rememberedVoices, type VisualHint } from "./voice-evidence.js"
import type { VoiceProposal, StoredVoice } from "./recording-processing.js"
import type { RecordingRow } from "./recordings.js"
import type { Sql } from "../database.js"
import type { MemoryStore } from "../store.js"

/**
 * Names for the voices of a recorded meeting.
 *
 * A model proposes which invited attendee each voice is; the proposal is stored next to the voiceprint and never
 * applied on its own. Confirming assigns every fragment of that voice to the person as a manual assignment, so the
 * name survives a reprocessing of the recording.
 */

const CONFIDENCES = ["high", "medium", "low"] as const
const PENDING_LIMIT = 50

const matchSchema = z.object({ voice_id: z.string(), name: z.string().trim().min(2).max(100), evidence_id: z.string(), confidence: z.enum(CONFIDENCES), reason: z.string().max(600) })
const responseSchema = z.object({ matches: z.array(z.unknown()) })
export const voiceDecisionInput = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("confirm"), email: z.email().optional(), person_id: z.uuid().optional(), remember: z.boolean().optional() }).strict()
    .refine(input => Boolean(input.email) !== Boolean(input.person_id), "Elegí una persona o un correo"),
  z.object({ decision: z.literal("dismiss") }).strict(),
])

interface VoiceFragment { offset_ms: number; text: string; voice: number | null; track: string | null; resolution: string | null }

/** Invitees a voice can be. The person recording is one of them only when the microphone was not attributed to them (single-track recording). */
function candidatesOf(row: RecordingRow) {
  const owned = (row.speakers as StoredVoice[]).some(voice => voice.status === "self")
  return (row.event?.attendees ?? []).filter(attendee => attendee.email && !(attendee.self && owned))
    .map(attendee => ({ email: attendee.email!.toLowerCase(), name: attendee.name || attendee.email! }))
}

async function fragmentsOf(store: MemoryStore, entityId: string): Promise<VoiceFragment[]> {
  return store.db.query<VoiceFragment>(`SELECT f.offset_ms,f.text,CAST(f.metadata->>'voice' AS INTEGER) AS voice,f.metadata->>'track' AS track,f.metadata->>'speaker_resolution' AS resolution FROM fragments f
    JOIN sources s ON s.current_version_id=f.version_id WHERE s.entity_id=$1 ORDER BY f.ordinal`, [entityId])
}

/** Every word is reviewed, even when one fragment exceeds a request. Keep a timestamp and an evidence id with each piece. */
function transcriptBatches(fragments: VoiceFragment[], hints: VisualHint[]) {
  const entries = fragments.flatMap((fragment, index) => {
    const text = fragment.text
    const speaker = fragment.voice && fragment.voice > 0 ? `v${fragment.voice}` : fragment.resolution === "recording_owner" ? "me" : "unknown"
    const pieces = []
    for (let start = 0; start < text.length; start += 6000) pieces.push({
      id: `f${index + 1}.${start}`, offset_ms: fragment.offset_ms ?? 0, speaker, text: text.slice(start, start + 6000), kind: "speech",
    })
    return pieces
  })
  for (const [index, hint] of hints.entries()) entries.push({ id: `w${index + 1}`, offset_ms: hint.offset,
    speaker: hint.voice ? `v${hint.voice}` : "unknown", text: hint.name, kind: "window_label" })
  entries.sort((a, b) => a.offset_ms - b.offset_ms)
  const batches: (typeof entries)[] = []
  let batch: typeof entries = [], length = 0
  for (const entry of entries) {
    const size = JSON.stringify(entry).length
    if (batch.length && length + size > 24000) { batches.push(batch); batch = []; length = 0 }
    batch.push(entry); length += size
  }
  if (batch.length) batches.push(batch)
  return batches
}

async function canReview(store: MemoryStore, entityId: string, config: AIConfig): Promise<boolean> {
  if (!config.extraction_model || config.extraction === "disabled") return false
  if (!usesRemoteExtraction(config)) return true
  if (!config.remote_processing_enabled) return false
  const [entity] = await store.db.query<{ data: Record<string, unknown> }>("SELECT data FROM entities WHERE id=$1", [entityId])
  if (!entity || entity.data.remote_processing === false) return false
  const projects = await store.db.query(`SELECT id FROM entities WHERE kind='project' AND (data->>'remote_processing') IN (0,'false')
    AND (id IN(SELECT to_id FROM links WHERE from_id=$1 AND type='project')
      OR id IN(SELECT fp.project_id FROM fragment_projects fp JOIN fragments f ON f.id=fp.fragment_id
        JOIN sources s ON s.current_version_id=f.version_id WHERE s.entity_id=$1))`, [entityId])
  return !projects.length
}

export async function proposeVoiceNames(store: MemoryStore, ai: MemoryAI, config: AIConfig, recordingId: string, signal: AbortSignal, hints: VisualHint[] = []) {
  const row = (await store.db.query<RecordingRow>("SELECT * FROM recordings WHERE id=$1", [recordingId]))[0]
  const voices = ((row?.speakers ?? []) as StoredVoice[]).filter(v => v.status === "unresolved")
  if (!row?.entity_id || !voices.length) return { voice_proposals: 0 }
  const version = async () => (await store.db.query<{ current_version_id: string }>("SELECT current_version_id FROM sources WHERE entity_id=$1", [row.entity_id]))[0]?.current_version_id
  const reviewedVersion = await version()
  const evidence = new Map<number, VoiceProposal[]>()
  const add = (voice: number, proposal: VoiceProposal) => { const list = evidence.get(voice) ?? []; list.push(proposal); evidence.set(voice, list) }
  for (const [voice, proposal] of await rememberedVoices(store, recordingId, voices)) add(voice, proposal)
  const candidates = candidatesOf(row)
  const candidateFor = (name: string) => {
    const matches = candidates.filter(c => canonicalName(c.name) === canonicalName(name))
    return matches.length === 1 ? matches[0] : undefined
  }
  for (const voice of voices) {
    const anchored = hints.filter(h => h.voice === voice.voice)
    for (const name of new Set(anchored.map(h => h.name))) {
      const matches = anchored.filter(h => h.name === name)
      if (matches.length < 2 || matches.at(-1)!.offset - matches[0]!.offset < 1500) continue
      add(voice.voice, { email: "", name, ...candidateFor(name), confidence: "medium", reason: "La ventana de la llamada mostró este nombre en varios momentos de esta voz." })
    }
  }
  const batches = transcriptBatches(await fragmentsOf(store, row.entity_id), hints)
  const fromModel: { voice: number; proposal: VoiceProposal }[] = []
  let reviewed = 0, interrupted = false
  for (const batch of batches) {
    signal.throwIfAborted()
    if (!await canReview(store, row.entity_id, config)) break
    const result = await ai.extract("Review this chronological section of a meeting. Identify unresolved acoustic voices only with direct evidence such as an explicit introduction, or a window_label aligned to that voice corroborated by speech. 'me' is the recorder. A name merely mentioned or a pinned participant is insufficient. Evidence and captions may be wrong, mixed or delayed. Never guess from an attendee list or from an unknown voice. For each justified match return {voice_id,name,evidence_id,confidence,reason}. Use exact candidate name or literal name in the evidence. Cite an entry from this section. Reasons in Spanish. When uncertain omit the match.",
      { title: row.title, candidates, voices: voices.map(v => `v${v.voice}`), entries: batch }, responseSchema, raw => raw as z.infer<typeof responseSchema>).catch(() => null)
    if (!result) { interrupted = true; break }
    reviewed++
    for (const match of lenientItems(result.value, "matches", matchSchema)) {
      const voice = voices.find(v => `v${v.voice}` === match.voice_id)
      const anchor = batch.find(e => e.id === match.evidence_id)
      if (!voice || !anchor || anchor.speaker !== match.voice_id) continue
      const candidate = candidateFor(match.name)
      if (!candidate && !canonicalName(anchor.text).includes(canonicalName(match.name))) continue
      fromModel.push({ voice: voice.voice, proposal: { email: "", name: match.name, ...candidate, confidence: match.confidence, reason: match.reason } })
    }
  }
  signal.throwIfAborted()
  // If a later section couldn't be reviewed, it may contradict an earlier one. Local evidence still applies.
  if (reviewed === batches.length) for (const { voice, proposal } of fromModel) add(voice, proposal)
  return store.db.transaction(async sql => {
    const [current] = await sql.query<{ speakers: StoredVoice[]; current_version_id: string }>(`SELECT r.speakers,s.current_version_id FROM recordings r
      JOIN sources s ON s.entity_id=r.entity_id WHERE r.id=$1 AND r.state='ready'`, [recordingId])
    if (!current || current.current_version_id !== reviewedVersion) return { voice_proposals: 0 }
    let proposals = 0
    for (const voice of current.speakers) {
      if (voice.status !== "unresolved") continue
      const matches = evidence.get(voice.voice) ?? []
      if (!matches.length || new Set(matches.map(m => canonicalName(m.name))).size !== 1) { delete voice.proposal; continue }
      // Keep an explicit remembered person id. Conflicting evidence never becomes an assignment.
      voice.proposal = matches.find(m => m.person_id) ?? matches.find(m => m.confidence === "high") ?? matches[0]!
      proposals++
    }
    await sql.query("UPDATE recordings SET speakers=$2,updated_at=now() WHERE id=$1", [recordingId, JSON.stringify(current.speakers)])
    return { voice_proposals: proposals, voice_sections_reviewed: reviewed, ...(interrupted ? { voice_naming: "failed" } : {}) }
  })
}

/** Voices still without a name, newest meeting first, each with its proposal, a sample of what it said and the invitees to choose from. */
export async function listPendingVoices(store: MemoryStore) {
  const rows = await store.db.query<RecordingRow>("SELECT * FROM recordings WHERE state='ready' AND entity_id IS NOT NULL ORDER BY started_at DESC LIMIT 100")
  const items: Record<string, unknown>[] = []
  for (const row of rows) {
    const pending = (row.speakers as StoredVoice[]).filter(voice => voice.status === "unresolved")
    if (!pending.length) continue
    const fragments = await fragmentsOf(store, row.entity_id!), candidates = candidatesOf(row)
    for (const voice of pending) {
      const sample = fragments.find(fragment => fragment.voice === voice.voice)?.text
      if (!sample) continue
      items.push({ recording_id: row.id, entity_id: row.entity_id, title: row.title, started_at: row.started_at, voice: voice.voice, seconds: Math.round(voice.seconds),
        sample: sample.slice(0, 200), proposal: voice.proposal ?? null, candidates })
      if (items.length >= PENDING_LIMIT) return { items }
    }
  }
  return { items }
}

/** Assigns every fragment of a voice in one version to a person, as a manual assignment. Returns the number of fragments. */
export async function assignVoice(sql: Sql, entityId: string, versionId: string, voiceNumber: number, personId: string): Promise<number> {
  const updated = await sql.query(`UPDATE fragments SET speaker_id=$2,metadata=jsonb_merge(metadata,'{"manual_assignment":true,"speaker_resolution":"confirmed_voice"}')
    WHERE version_id=$1 AND CAST(metadata->>'voice' AS INTEGER)=$3 RETURNING id`, [versionId, personId, voiceNumber])
  await sql.query("INSERT INTO links(id,from_id,to_id,type) VALUES($1,$2,$3,'participant') ON CONFLICT DO NOTHING", [randomUUID(), entityId, personId])
  return updated.length
}

/** Confirms who a voice is, or leaves it unnamed. Confirming assigns every fragment of the voice in the current version of the meeting. */
export async function decideVoice(store: MemoryStore, recordingId: string, voiceNumber: number, raw: unknown) {
  const input = parse(voiceDecisionInput, raw), email = input.decision === "confirm" ? input.email?.toLowerCase() : null
  const known = (await store.db.query<RecordingRow>("SELECT * FROM recordings WHERE id=$1", [recordingId]))[0]
  check(known?.entity_id, "La grabación no existe o todavía no se procesó", 404)
  let candidate = email ? candidatesOf(known).find(item => item.email === email) : undefined
  let personId: string | undefined
  if (input.decision === "confirm" && input.person_id) {
    const person = (await store.db.query<{ id: string; title: string }>("SELECT id,title FROM entities WHERE id=$1 AND kind='person' AND data->>'merged_into' IS NULL", [input.person_id]))[0]
    check(person, "La persona seleccionada ya no está disponible", 422)
    personId = person.id; candidate = { email: "", name: person.title }
  }
  if (email) {
    check(candidate, "Esa persona no figura entre los invitados de la reunión", 422)
    const external = `recording-voice:${email}`
    await store.refreshParticipants({ provider: "manual", account: "local" }, [{ external_id: external, name: candidate.name, email, identity_verified: false }])
    personId = (await store.db.query<{ person_id: string }>("SELECT person_id FROM identities WHERE provider='manual' AND account='local' AND external_id=$1", [external]))[0]?.person_id
    check(personId, "No se pudo resolver la persona", 409)
  }
  // The voice list is read and written inside one transaction: a proposal or another decision saved meanwhile is not overwritten.
  return store.db.transaction(async sql => {
    const row = (await sql.query<RecordingRow>("SELECT * FROM recordings WHERE id=$1", [recordingId]))[0]
    check(row?.entity_id, "La grabación no existe o todavía no se procesó", 404)
    check(row.state === "ready", "La grabación se está procesando; probá de nuevo en un momento", 409)
    const speakers = row.speakers as StoredVoice[], voice = speakers.find(item => item.voice === voiceNumber && item.status !== "self")
    check(voice, "Esa voz no existe en la grabación", 404)
    let updated = 0
    if (personId && candidate) {
      const version = (await sql.query<{ current_version_id: string }>("SELECT current_version_id FROM sources WHERE entity_id=$1", [row.entity_id]))[0]?.current_version_id
      check(version, "La reunión ya no tiene una versión vigente", 409)
      updated = await assignVoice(sql, row.entity_id, version, voiceNumber, personId)
      voice.status = "confirmed"
      voice.remember = input.decision === "confirm" && input.remember === true
      voice.person_id = personId
      voice.label = candidate.name
      await sql.query("DELETE FROM rule_runs WHERE version_id=$1", [version])
      await store.enqueue("process", { version_id: version }, `process:${version}`, sql)
    } else voice.status = "dismissed"
    await sql.query("UPDATE recordings SET speakers=$2,updated_at=now() WHERE id=$1", [recordingId, JSON.stringify(speakers)])
    return { updated, status: voice.status, ...(personId ? { person_id: personId } : {}) }
  })
}
