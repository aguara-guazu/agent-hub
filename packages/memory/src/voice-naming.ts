import { randomUUID } from "node:crypto"
import { z } from "zod"
import { lenientItems, type MemoryAI } from "./ai.js"
import { usesRemoteExtraction, type AIConfig } from "./config.js"
import { check, parse } from "./contracts.js"
import type { StoredVoice } from "./recording-processing.js"
import type { RecordingRow } from "./recordings.js"
import type { MemoryStore } from "./store.js"

/**
 * Names for the voices of a recorded meeting.
 *
 * A model proposes which invited attendee each voice is; the proposal is stored next to the voiceprint and never
 * applied on its own. Confirming assigns every fragment of that voice to the person as a manual assignment, so the
 * name survives a reprocessing of the recording.
 */

const CONFIDENCES = ["high", "medium", "low"] as const
const TRANSCRIPT_FRAGMENTS = 160
const FRAGMENT_CHARS = 320
const PENDING_LIMIT = 50

const matchSchema = z.object({ voice_id: z.string(), candidate_id: z.string().nullable(), confidence: z.enum(CONFIDENCES), reason: z.string().max(600) })
const responseSchema = z.object({ matches: z.array(z.unknown()) })
export const voiceDecisionInput = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("confirm"), email: z.email() }).strict(),
  z.object({ decision: z.literal("dismiss") }).strict(),
])

interface VoiceFragment { text: string; voice: number | null; track: string | null }

const candidatesOf = (row: RecordingRow) => (row.event?.attendees ?? []).filter(attendee => !attendee.self && attendee.email)
  .map(attendee => ({ email: attendee.email!.toLowerCase(), name: attendee.name || attendee.email! }))

async function fragmentsOf(store: MemoryStore, entityId: string): Promise<VoiceFragment[]> {
  return store.db.query<VoiceFragment>(`SELECT f.text,CAST(f.metadata->>'voice' AS INTEGER) AS voice,f.metadata->>'track' AS track FROM fragments f
    JOIN sources s ON s.current_version_id=f.version_id WHERE s.entity_id=$1 ORDER BY f.ordinal`, [entityId])
}

/** Asks the configured model which attendee each unresolved voice is. Skipped when the model may not process this content. */
export async function proposeVoiceNames(store: MemoryStore, ai: MemoryAI, config: AIConfig, recordingId: string, signal: AbortSignal) {
  const row = (await store.db.query<RecordingRow>("SELECT * FROM recordings WHERE id=$1", [recordingId]))[0]
  const voices = ((row?.speakers ?? []) as StoredVoice[]).filter(voice => voice.status === "unresolved"), candidates = row ? candidatesOf(row) : []
  if (!row?.entity_id || !voices.length || !candidates.length) return { voice_proposals: 0 }
  const allowed = Boolean(config.extraction_model) && config.extraction !== "disabled" && (!usesRemoteExtraction(config) || config.remote_processing_enabled)
  if (!allowed) return { voice_proposals: 0, voice_naming: "disabled" }
  const fragments = await fragmentsOf(store, row.entity_id)
  const voiceRefs = new Map(voices.map(voice => [`v${voice.voice}`, voice])), candidateRefs = new Map(candidates.map((candidate, index) => [`c${index + 1}`, candidate]))
  signal.throwIfAborted()
  const result = await ai.extract("The voices of a recorded meeting were separated acoustically and labelled v1, v2, etc.; 'me' is the person who recorded it. "
    + "Propose which invited attendee each voice is, from how people address each other, self-introductions, roles and topics. candidate_id only from input. "
    + "Invitees may not have attended, a voice may belong to someone who was not invited, and two voices may be one person split by the separation: omit a voice or return candidate_id null when unsure. "
    + "Never give one candidate to two voices unless the evidence is direct for both. Being the only invitee left never justifies high confidence. "
    + "High confidence only for direct evidence: the voice introduces itself or is addressed by that name right before or after it speaks. "
    + "Copy voice_id v1/v2 and candidate_id c1/c2 verbatim. Write reason in neutral Spanish (no voseo), one or two sentences quoting the evidence, with readable names and no v1/c1 codes.",
  { title: row.title, candidates: [...candidateRefs].map(([id, candidate]) => ({ id, ...candidate })),
    voices: voices.map(voice => ({ id: `v${voice.voice}`, seconds_speaking: Math.round(voice.seconds) })),
    transcript: fragments.slice(0, TRANSCRIPT_FRAGMENTS).map(fragment => ({ speaker: fragment.track === "mic" ? "me" : fragment.voice === null ? "unknown" : `v${fragment.voice}`, text: fragment.text.slice(0, FRAGMENT_CHARS) })) },
  responseSchema, raw => raw as z.infer<typeof responseSchema>)
  signal.throwIfAborted()
  let proposals = 0
  const seen = new Set<number>()
  for (const match of lenientItems(result.value, "matches", matchSchema)) {
    const voice = voiceRefs.get(match.voice_id), candidate = match.candidate_id ? candidateRefs.get(match.candidate_id) : undefined
    if (!voice || !candidate || seen.has(voice.voice)) continue
    seen.add(voice.voice)
    voice.proposal = { ...candidate, confidence: match.confidence, reason: match.reason }
    proposals++
  }
  // Only the proposals are merged back: a decision taken while the model was answering must not be overwritten.
  await store.db.transaction(async sql => {
    const current = ((await sql.query<{ speakers: StoredVoice[] }>("SELECT speakers FROM recordings WHERE id=$1", [recordingId]))[0]?.speakers ?? [])
    for (const stored of current) { const proposed = voices.find(voice => voice.voice === stored.voice)?.proposal; if (proposed && stored.status === "unresolved") stored.proposal = proposed }
    await sql.query("UPDATE recordings SET speakers=$2,updated_at=now() WHERE id=$1", [recordingId, JSON.stringify(current)])
  })
  return { voice_proposals: proposals }
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
      const sample = fragments.find(fragment => fragment.track === "system" && fragment.voice === voice.voice)?.text
      if (!sample) continue
      items.push({ recording_id: row.id, entity_id: row.entity_id, title: row.title, started_at: row.started_at, voice: voice.voice, seconds: Math.round(voice.seconds),
        sample: sample.slice(0, 200), proposal: voice.proposal ?? null, candidates })
      if (items.length >= PENDING_LIMIT) return { items }
    }
  }
  return { items }
}

/** Confirms who a voice is, or leaves it unnamed. Confirming assigns every fragment of the voice in the current version of the meeting. */
export async function decideVoice(store: MemoryStore, recordingId: string, voiceNumber: number, raw: unknown) {
  const input = parse(voiceDecisionInput, raw)
  const row = (await store.db.query<RecordingRow>("SELECT * FROM recordings WHERE id=$1", [recordingId]))[0]
  check(row?.entity_id, "La grabación no existe o todavía no se procesó", 404)
  const voice = (row.speakers as StoredVoice[]).find(item => item.voice === voiceNumber && item.status !== "self")
  check(voice, "Esa voz no existe en la grabación", 404)
  if (input.decision === "dismiss") {
    voice.status = "dismissed"
    await store.db.query("UPDATE recordings SET speakers=$2,updated_at=now() WHERE id=$1", [recordingId, JSON.stringify(row.speakers)])
    return { updated: 0, status: voice.status }
  }
  const email = input.email.toLowerCase(), candidate = candidatesOf(row).find(item => item.email === email)
  check(candidate, "Esa persona no figura entre los invitados de la reunión", 422)
  const external = `recording-voice:${email}`
  await store.refreshParticipants({ provider: "manual", account: "local" }, [{ external_id: external, name: candidate.name, email, identity_verified: false }])
  const personId = (await store.db.query<{ person_id: string }>("SELECT person_id FROM identities WHERE provider='manual' AND account='local' AND external_id=$1", [external]))[0]?.person_id
  check(personId, "No se pudo resolver la persona", 409)
  return store.db.transaction(async sql => {
    const version = (await sql.query<{ current_version_id: string }>("SELECT current_version_id FROM sources WHERE entity_id=$1", [row.entity_id]))[0]?.current_version_id
    check(version, "La reunión ya no tiene una versión vigente", 409)
    const updated = await sql.query(`UPDATE fragments SET speaker_id=$2,metadata=jsonb_merge(metadata,'{"manual_assignment":true,"speaker_resolution":"confirmed_voice"}')
      WHERE version_id=$1 AND (metadata->>'track')='system' AND CAST(metadata->>'voice' AS INTEGER)=$3 RETURNING id`, [version, personId, voiceNumber])
    await sql.query("INSERT INTO links(id,from_id,to_id,type) VALUES($1,$2,$3,'participant') ON CONFLICT DO NOTHING", [randomUUID(), row.entity_id, personId])
    voice.status = "confirmed"
    voice.person_id = personId
    voice.label = candidate.name
    await sql.query("UPDATE recordings SET speakers=$2,updated_at=now() WHERE id=$1", [recordingId, JSON.stringify(row.speakers)])
    await sql.query("DELETE FROM rule_runs WHERE version_id=$1", [version])
    await store.enqueue("process", { version_id: version }, `process:${version}`, sql)
    return { updated: updated.length, status: voice.status, person_id: personId }
  })
}
