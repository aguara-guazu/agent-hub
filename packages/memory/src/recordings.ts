import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { z } from "zod"
import { check, id, instant, parse } from "./contracts.js"
import type { MemoryStore } from "./store.js"

/**
 * Registry of local meeting recordings.
 *
 * The desktop app writes each track to its own state directory while recording; registering moves the audio under
 * `<memory>/recordings/<id>/` and queues the `recording` job that turns it into a meeting. Audio is kept for
 * `retention_days` after processing and then deleted; the transcript stays in the meeting.
 */

export const RECORDING_TRACKS = ["mic", "system"] as const
export type RecordingTrack = (typeof RECORDING_TRACKS)[number]
const TRACK_FILES: Record<RecordingTrack, string> = { mic: "mic.webm", system: "system.webm" }
/** Longest recording the desktop produces plus slack for a clock change mid-recording. */
const MAX_RECORDING_MS = 4 * 60 * 60_000

export const recordingSettingsInput = z.object({
  notify: z.boolean().default(true),
  lead_minutes: z.number().int().min(0).max(30).default(2),
  retention_days: z.number().int().min(1).max(365).default(30),
}).strict()
export type RecordingSettings = z.infer<typeof recordingSettingsInput>

export async function recordingSettings(store: MemoryStore): Promise<RecordingSettings> {
  return parse(recordingSettingsInput, (await store.db.query("SELECT value FROM settings WHERE key='recording'"))[0]?.value ?? {})
}

const attendee = z.object({ email: z.email().optional(), name: z.string().max(300).optional(), self: z.boolean().optional(), response: z.string().max(40).optional() }).strict()
export const recordingEvent = z.object({
  connector_id: id, calendar: z.string().min(1).max(500), event_id: z.string().min(1).max(500),
  title: z.string().max(500), start: instant.nullable(), end: instant.nullable(),
  platform: z.string().max(40).nullable().default(null), attendees: z.array(attendee).max(500).default([]),
}).strict()
export type RecordingEvent = z.infer<typeof recordingEvent>

const trackMeta = z.object({ file: z.string(), started_at: instant.nullable(), bytes: z.number().int().nonnegative(), error: z.string().optional() })
const recordingMeta = z.object({
  schema: z.literal(1), id, title: z.string().trim().min(1).max(500), event_id: z.string().nullable().optional(), scheduled_end: z.string().nullable().optional(),
  started_at: instant, ended_at: instant.nullable(), tracks: z.partialRecord(z.enum(RECORDING_TRACKS), trackMeta), app_version: z.string().max(100).optional(),
})
export const registerRecordingInput = z.object({ directory: z.string().min(1).max(4000), event: recordingEvent.optional() }).strict()

export interface StoredTrack { file: string; started_at: string; bytes: number }
export interface RecordingRow {
  id: string; state: "queued" | "processing" | "ready" | "failed"; title: string; event: RecordingEvent | null
  started_at: string; ended_at: string; directory: string; tracks: Partial<Record<RecordingTrack, StoredTrack>>
  speakers: unknown[]; entity_id: string | null; error: string | null; audio_expires_at: string | null; audio_deleted_at: string | null
}

export const recordingDirectory = (memoryDirectory: string, recordingId: string): string => join(memoryDirectory, "recordings", recordingId)

/** Copies a finished recording under the memory directory, stores its row and queues its processing. Registering twice is a no-op. */
export async function registerRecording(store: MemoryStore, memoryDirectory: string, request: unknown) {
  const input = parse(registerRecordingInput, request)
  check(isAbsolute(input.directory), "La carpeta de la grabación debe ser una ruta absoluta")
  const raw = await readFile(join(input.directory, "meta.json"), "utf8").catch(() => null)
  check(raw, "La carpeta no contiene una grabación", 404)
  const meta = parse(recordingMeta, JSON.parse(raw))
  const existing = (await store.db.query<RecordingRow>("SELECT * FROM recordings WHERE id=$1", [meta.id]))[0]
  if (existing) return view(existing)
  const tracks: Partial<Record<RecordingTrack, StoredTrack>> = {}
  for (const name of RECORDING_TRACKS) {
    const track = meta.tracks[name]
    if (!track?.started_at || track.error) continue
    const size = await stat(join(input.directory, TRACK_FILES[name])).then(file => file.size, () => 0)
    if (size > 0) tracks[name] = { file: TRACK_FILES[name], started_at: track.started_at, bytes: size }
  }
  check(Object.keys(tracks).length > 0, "La grabación no tiene audio")
  const first = Math.min(...Object.values(tracks).map(track => Date.parse(track.started_at)))
  // An interrupted recording has no end time: the desktop fills it from the last write before registering.
  const endedAt = meta.ended_at ?? new Date().toISOString()
  check(Date.parse(endedAt) > first && Date.parse(endedAt) - first <= MAX_RECORDING_MS, "La duración de la grabación no es válida")
  const directory = recordingDirectory(memoryDirectory, meta.id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const track of Object.values(tracks)) await copyFile(join(input.directory, track.file), join(directory, track.file))
  const row = (await store.db.query<RecordingRow>(`INSERT INTO recordings(id,title,event,started_at,ended_at,directory,tracks)
    VALUES($1,$2,$3,ts($4),ts($5),$6,$7) RETURNING *`,
    [meta.id, input.event?.title.trim() || meta.title, input.event ? JSON.stringify(input.event) : null, new Date(first).toISOString(), endedAt, directory, JSON.stringify(tracks)]))[0]!
  await store.enqueue("recording", { recording_id: meta.id }, `recording:${meta.id}`)
  await rm(input.directory, { recursive: true, force: true }).catch(() => undefined)
  return view(row)
}

function view(row: RecordingRow) {
  return { id: row.id, state: row.state, title: row.title, started_at: row.started_at, ended_at: row.ended_at, entity_id: row.entity_id, error: row.error,
    tracks: Object.keys(row.tracks), audio_expires_at: row.audio_expires_at, audio_deleted_at: row.audio_deleted_at,
    event: row.event ? { title: row.event.title, platform: row.event.platform } : null }
}

export async function listRecordings(store: MemoryStore) {
  return { items: (await store.db.query<RecordingRow>("SELECT * FROM recordings ORDER BY started_at DESC LIMIT 200")).map(view) }
}

/** Deletes the audio of one recording; the meeting and its transcript are kept. */
export async function deleteRecordingAudio(store: MemoryStore, recordingId: string) {
  const row = (await store.db.query<RecordingRow>("SELECT * FROM recordings WHERE id=$1", [recordingId]))[0]
  check(row, "La grabación no existe", 404)
  check(row.state === "ready" || row.state === "failed", "La grabación todavía se está procesando", 409)
  await rm(row.directory, { recursive: true, force: true })
  return view((await store.db.query<RecordingRow>("UPDATE recordings SET audio_deleted_at=now(),updated_at=now() WHERE id=$1 RETURNING *", [recordingId]))[0]!)
}

/** Removes audio past its retention date. Runs from the job scheduler. */
export async function sweepRecordings(store: MemoryStore): Promise<number> {
  const due = await store.db.query<RecordingRow>(`SELECT * FROM recordings WHERE audio_deleted_at IS NULL AND audio_expires_at IS NOT NULL AND audio_expires_at<now()
    AND state IN ('ready','failed')`)
  for (const row of due) {
    await rm(row.directory, { recursive: true, force: true }).catch(() => undefined)
    await store.db.query("UPDATE recordings SET audio_deleted_at=now(),updated_at=now() WHERE id=$1", [row.id])
  }
  return due.length
}
