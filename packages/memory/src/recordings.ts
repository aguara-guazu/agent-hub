import { copyFile, lstat, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join } from "node:path"
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

const trackMeta = z.object({ file: z.string(), started_at: instant.nullable(), bytes: z.number().int().nonnegative(), error: z.string().optional(), interrupted: z.string().optional() })
export const speakerHints = z.array(z.object({ at: z.number().int().nonnegative(), name: z.string().trim().min(1).max(100) })).max(12000)
const recordingMeta = z.object({
  schema: z.literal(1), id, title: z.string().trim().min(1).max(500), event_id: z.string().nullable().optional(), scheduled_end: z.string().nullable().optional(),
  started_at: instant, ended_at: instant.nullable(), tracks: z.partialRecord(z.enum(RECORDING_TRACKS), trackMeta), app_version: z.string().max(100).optional(),
  incomplete: z.boolean().optional(), speaker_hints: z.unknown().optional(),
})
export const registerRecordingInput = z.object({ directory: z.string().min(1).max(4000), event: recordingEvent.optional() }).strict()

export interface StoredTrack { file: string; started_at: string; bytes: number; incomplete?: boolean }
export interface RecordingRow {
  id: string; state: "queued" | "processing" | "ready" | "failed"; title: string; event: RecordingEvent | null
  started_at: string; ended_at: string; directory: string; tracks: Partial<Record<RecordingTrack, StoredTrack>>
  speakers: unknown[]; entity_id: string | null; error: string | null; audio_expires_at: string | null; audio_deleted_at: string | null
}

export const recordingDirectory = (memoryDirectory: string, recordingId: string): string => join(memoryDirectory, "recordings", recordingId)

const activeJob = "EXISTS(SELECT 1 FROM jobs j WHERE j.kind='recording' AND j.payload->>'recording_id'=recordings.id AND j.state IN ('queued','running','waiting'))"

/**
 * Copies a finished recording under the memory directory, stores its row and queues its processing.
 *
 * Idempotent: a second delivery of the same recording (the first one was cut between the copy and the reply) queues the
 * job again if it never started and removes the source. Only the known files of the source directory are read and
 * deleted, and only regular files are accepted, so a path that is not a recording directory is left untouched.
 */
export async function registerRecording(store: MemoryStore, memoryDirectory: string, request: unknown) {
  const input = parse(registerRecordingInput, request)
  check(isAbsolute(input.directory), "La carpeta de la grabación debe ser una ruta absoluta")
  const raw = await readFile(join(input.directory, "meta.json"), "utf8").catch(() => null)
  check(raw, "La carpeta no contiene una grabación", 404)
  const meta = parse(recordingMeta, JSON.parse(raw))
  check(basename(input.directory) === meta.id, "La carpeta no corresponde a esa grabación")
  const discard = async () => {
    for (const file of ["meta.json", "event.json", ...Object.values(TRACK_FILES)]) await rm(join(input.directory, file), { force: true }).catch(() => undefined)
    await rmdir(input.directory).catch(() => undefined)
  }
  const existing = (await store.db.query<RecordingRow>("SELECT * FROM recordings WHERE id=$1", [meta.id]))[0]
  if (existing) {
    if (existing.state === "queued") await store.enqueue("recording", { recording_id: meta.id }, `recording:${meta.id}`)
    await discard()
    return view(existing)
  }
  const tracks: Partial<Record<RecordingTrack, StoredTrack>> = {}
  for (const name of RECORDING_TRACKS) {
    const track = meta.tracks[name]
    if (!track?.started_at || track.error) continue
    const file = await lstat(join(input.directory, TRACK_FILES[name])).catch(() => null)
    if (file?.isFile() && file.size > 0) tracks[name] = { file: TRACK_FILES[name], started_at: track.started_at, bytes: file.size,
      ...(meta.incomplete || track.interrupted ? { incomplete: true } : {}) }
  }
  check(Object.keys(tracks).length > 0, "La grabación no tiene audio")
  const first = Math.min(...Object.values(tracks).map(track => Date.parse(track.started_at)))
  // Wall-clock times are only a reference: a Mac that slept mid-recording reports a span longer than its audio, and
  // an interrupted recording has no end at all.
  const ended = new Date(Math.max(Date.parse(meta.ended_at ?? "") || 0, first + 1000)).toISOString()
  const directory = recordingDirectory(memoryDirectory, meta.id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const track of Object.values(tracks)) await copyFile(join(input.directory, track.file), join(directory, track.file))
  const hints = speakerHints.safeParse(meta.speaker_hints)
  if (hints.success && hints.data.length) await writeFile(join(directory, "speaker-hints.json"), JSON.stringify(hints.data), { mode: 0o600 })
  // The retention date is set from the start, so the audio of a recording whose processing fails still expires.
  const expires = new Date(Date.now() + (await recordingSettings(store)).retention_days * 86_400_000).toISOString()
  const row = (await store.db.query<RecordingRow>(`INSERT INTO recordings(id,title,event,started_at,ended_at,directory,tracks,audio_expires_at)
    VALUES($1,$2,$3,ts($4),ts($5),$6,$7,ts($8)) RETURNING *`,
    [meta.id, input.event?.title.trim() || meta.title, input.event ? JSON.stringify(input.event) : null, new Date(first).toISOString(), ended, directory, JSON.stringify(tracks), expires]))[0]!
  await store.enqueue("recording", { recording_id: meta.id }, `recording:${meta.id}`)
  await discard()
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

/** Deletes the audio of one recording; the meeting and its transcript are kept. Refused only while its job is queued or running. */
export async function deleteRecordingAudio(store: MemoryStore, recordingId: string) {
  const row = (await store.db.query<RecordingRow & { busy: boolean }>(`SELECT recordings.*,${activeJob} AS "busy:bool" FROM recordings WHERE id=$1`, [recordingId]))[0]
  check(row, "La grabación no existe", 404)
  check(!row.busy, "La grabación todavía se está procesando", 409)
  await rm(row.directory, { recursive: true, force: true })
  return view((await store.db.query<RecordingRow>("UPDATE recordings SET audio_deleted_at=now(),updated_at=now() WHERE id=$1 RETURNING *", [recordingId]))[0]!)
}

/**
 * Housekeeping from the job scheduler: a recording whose job ended without reaching a final state (cancelled, or the
 * worker died on every attempt) is marked failed, and audio past its retention date is removed whatever its state.
 */
export async function sweepRecordings(store: MemoryStore): Promise<number> {
  await store.db.query(`UPDATE recordings SET state='failed',error=COALESCE(error,'El procesamiento de la grabación se interrumpió'),updated_at=now()
    WHERE state IN ('queued','processing') AND NOT ${activeJob} AND updated_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes')`)
  const due = await store.db.query<RecordingRow>(`SELECT * FROM recordings WHERE audio_deleted_at IS NULL AND audio_expires_at IS NOT NULL AND audio_expires_at<now() AND NOT ${activeJob}`)
  let removed = 0
  for (const row of due) {
    // A directory that could not be removed is tried again on the next pass instead of being reported as deleted.
    if (!await rm(row.directory, { recursive: true, force: true }).then(() => true, () => false)) continue
    await store.db.query("UPDATE recordings SET audio_deleted_at=now(),updated_at=now() WHERE id=$1", [row.id])
    removed++
  }
  return removed
}
