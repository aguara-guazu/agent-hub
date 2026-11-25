import { spawn } from "node:child_process"
import { open, rm, stat, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as sleep } from "node:timers/promises"
import { check, MemoryError, type ImportInput } from "../contracts.js"
import { diarize, voiceprint, type VoiceTurn, type Voiceprint } from "../diarization.js"
import { mediaSettings } from "./media-processing.js"
import type { MediaRuntime } from "./media-runtime.js"
import { recordingSettings, RECORDING_TRACKS, type RecordingRow, type RecordingTrack } from "./recordings.js"
import type { MemoryStore } from "../store.js"
import type { MemoryAI } from "../ai.js"
import type { AIConfig } from "../config.js"
import { alignWindowHints } from "./voice-evidence.js"
import { assignVoice, proposeVoiceNames } from "./voice-naming.js"
import { readTranscriptCheckpoint, saveTranscriptCheckpoint, transcriptKey } from "./recording-checkpoint.js"
import { detectSpeech, speechWindows, type SpeechRegion } from "../speech-detection.js"
import { microphoneHasPlayback } from "./recording-echo.js"

/**
 * Turns a registered recording into a meeting.
 *
 * The `system` track carries everyone but the person recording: it is split by voice and each phrase is assigned to
 * the voice that overlaps it most. The `mic` track is a single known speaker. Voices are never given a name here:
 * system fragments are stored without a speaker and carry `metadata.voice`, so a name only arrives through an
 * explicit confirmation.
 */

const SAMPLE_RATE = 16000
const WINDOW_SECONDS = 30
/** A window is cut at its quietest point after this many seconds, so a cut rarely lands inside a word. */
const WINDOW_MIN_SECONDS = 20
const QUIET_FRAME_SECONDS = 0.3
/** Evaluate short frames: averaging over a 30-second window hides quiet speech between pauses. */
const MIC_SPEECH_RMS = 0.002
const SPEECH_FRAME_SECONDS = 0.1
const MIN_SPEECH_SECONDS = 0.3
const FRAGMENT_MAX_CHARS = 700
const FRAGMENT_MAX_GAP_SECONDS = 2
const ECHO_WINDOW_SECONDS = 3
const ECHO_WORD_RATIO = 0.7
const MODEL_INSTALL_TIMEOUT_MS = 60 * 60_000
/** Same cut-off the diarization uses to treat two voiceprints as one person. */
const SAME_VOICE_SIMILARITY = 0.85
const DECODE_TIMEOUT_MS = 20 * 60_000

type Progress = (value: Record<string, unknown>) => Promise<void>
interface Phrase { start: number; end: number; text: string }
interface Spoken extends Phrase { track: RecordingTrack; voice: number | null; owner?: boolean }
interface Installable { installed(): boolean; install(): unknown; status(): { state: string; error?: string | undefined } }
interface SpeechEngine { transcribe(audio: Float32Array, signal: AbortSignal, language?: string): Promise<{ chunks?: { text: string; timestamp: [number, number | null] }[] }>; unload(): Promise<void> }
export interface VoiceProposal { email: string; person_id?: string; name: string; confidence: "high" | "medium" | "low"; reason: string }
export interface StoredVoice { voice: number; label: string; seconds: number; embedding: number[]; status: "self" | "unresolved" | "confirmed" | "dismissed"; person_id?: string; remember?: boolean; proposal?: VoiceProposal }

async function ensureInstalled(module: Installable, signal: AbortSignal): Promise<boolean> {
  if (module.installed()) return true
  const deadline = Date.now() + MODEL_INSTALL_TIMEOUT_MS
  module.install()
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const state = module.status().state
    if (state === "ready" || module.installed()) return true
    if (state === "error" || state === "missing") return false
    await sleep(2000, undefined, { signal })
  }
  return false
}

function decode(ffmpeg: string, input: string, output: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    // Raw PCM has no timestamps. Preserve gaps in the recorder's packet clock before comparing the tracks.
    const timing = `asetpts=PTS-STARTPTS,aresample=${SAMPLE_RATE}:async=1:min_hard_comp=0.06:first_pts=0`
    const child = spawn(ffmpeg, ["-nostdin", "-nostats", "-hide_banner", "-v", "verbose", "-threads", "2", "-protocol_whitelist", "file,pipe",
      "-format_whitelist", "matroska,webm", "-i", input, "-map", "0:a:0", "-vn", "-ac", "1", "-af", timing, "-f", "f32le", "-y", output],
    { signal, timeout: DECODE_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true, stdio: ["ignore", "ignore", "pipe"] })
    let interrupted = false
    createInterface({ input: child.stderr }).on("line", line => {
      if (/\[SWR @ [^\]]+\] (?:adding|discarding) \d+ audio samples\b/.test(line)) interrupted = true
    })
    const fail = () => reject(new MemoryError(signal.aborted ? 499 : 422, signal.aborted ? "Procesamiento de la grabación cancelado" : "No se pudo decodificar el audio de la grabación"))
    child.once("error", fail)
    child.once("close", code => { if (code === 0) resolve(interrupted); else fail() })
  })
}

async function readSamples(file: FileHandle, start: number, count: number): Promise<Float32Array> {
  const samples = new Float32Array(count)
  const { bytesRead } = await file.read(Buffer.from(samples.buffer), 0, count * 4, start * 4)
  return bytesRead === count * 4 ? samples : samples.subarray(0, Math.floor(bytesRead / 4))
}

function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0
  for (let index = from; index < to; index++) sum += samples[index]! * samples[index]!
  return Math.sqrt(sum / Math.max(1, to - from))
}

/** Require sustained audible energy; a short click must not send an otherwise silent window to Whisper. */
function hasSpeechEnergy(samples: Float32Array): boolean {
  const frame = Math.round(SPEECH_FRAME_SECONDS * SAMPLE_RATE)
  let audible = 0
  for (let start = 0; start < samples.length; start += frame) {
    const end = Math.min(start + frame, samples.length)
    if (rms(samples, start, end) > MIC_SPEECH_RMS) audible += end - start
    if (audible >= MIN_SPEECH_SECONDS * SAMPLE_RATE) return true
  }
  return false
}

/** Sample index of the quietest frame in the tail of a full window. */
function quietCut(samples: Float32Array): number {
  const frame = Math.floor(QUIET_FRAME_SECONDS * SAMPLE_RATE)
  let best = samples.length, lowest = Infinity
  for (let start = WINDOW_MIN_SECONDS * SAMPLE_RATE; start + frame <= samples.length; start += frame) {
    const level = rms(samples, start, start + frame)
    if (level < lowest) { lowest = level; best = start + Math.floor(frame / 2) }
  }
  return best
}

const NON_SPEECH = /^[[(*♪].*[\])*♪]$/

async function transcribeTrack(engine: SpeechEngine, pcm: string, language: string, signal: AbortSignal,
  speechIn: (start: number, end: number, samples: Float32Array) => boolean, report: (seconds: number, total: number) => Promise<void>,
  processor: string, speechFilter: unknown, regions?: SpeechRegion[]): Promise<Phrase[]> {
  const total = Math.floor((await stat(pcm)).size / 4), path = `${pcm}.transcript.json`
  const key = await transcriptKey(pcm, { revision: 2, processor, language, speechFilter, regions }, signal)
  const checkpoint = await readTranscriptCheckpoint(path, key, total), phrases = checkpoint.phrases
  const file = await open(pcm, "r")
  const windows = regions ? speechWindows(regions, total / SAMPLE_RATE) : undefined
  try {
    for (let position = checkpoint.position; position < total;) {
      signal.throwIfAborted()
      const window = windows?.find(item => Math.round(item.end * SAMPLE_RATE) > position)
      if (windows && !window) { checkpoint.position = total; await saveTranscriptCheckpoint(path, checkpoint); break }
      if (window) position = Math.max(position, Math.round(window.start * SAMPLE_RATE))
      let samples = await readSamples(file, position, window ? Math.round(window.end * SAMPLE_RATE) - position : Math.min(WINDOW_SECONDS * SAMPLE_RATE, total - position))
      if (!samples.length) break
      if (!windows && position + samples.length < total) samples = samples.subarray(0, quietCut(samples))
      const start = position / SAMPLE_RATE, end = (position + samples.length) / SAMPLE_RATE
      await report(start, total / SAMPLE_RATE)
      if (windows || speechIn(start, end, samples)) {
        const result = await engine.transcribe(samples.slice(), signal, language)
        for (const chunk of result.chunks ?? []) {
          const text = chunk.text.trim()
          if (!text || NON_SPEECH.test(text) || !Number.isFinite(chunk.timestamp[0]) || chunk.timestamp[0] >= samples.length / SAMPLE_RATE) continue
          const from = Math.min(end, start + Math.max(0, chunk.timestamp[0])), to = Math.min(end, start + (chunk.timestamp[1] ?? samples.length / SAMPLE_RATE))
          if (to > from) phrases.push({ start: from, end: to, text })
        }
      }
      position += samples.length
      // Persist model output before the next progress write: a busy database must not discard completed inference.
      checkpoint.position = position
      await saveTranscriptCheckpoint(path, checkpoint)
    }
  } finally { await file.close() }
  return phrases
}

/** Attribute only an unambiguous phrase. A Whisper chunk may contain words from several speakers. */
function attribute(phrase: Phrase, turns: VoiceTurn[]): Phrase & { voice: number | null } {
  const overlap = new Map<number, number>()
  let nearest: { voice: number; distance: number } | null = null
  for (const turn of turns) {
    const shared = Math.min(phrase.end, turn.end) - Math.max(phrase.start, turn.start)
    if (shared > 0) overlap.set(turn.voice, (overlap.get(turn.voice) ?? 0) + shared)
    else if (!nearest || -shared < nearest.distance) nearest = { voice: turn.voice, distance: -shared }
  }
  if (!overlap.size) return { ...phrase, voice: nearest && nearest.distance <= 1 && nearest.voice > 0 ? nearest.voice : null }
  const voice = [...overlap].sort((a, b) => b[1] - a[1])[0]![0]
  if (voice <= 0) return { ...phrase, voice: null }
  // Picking the longest overlap would attach the other person's words to this identity when confirmed.
  // Allow small boundary errors, but retain a mixed phrase in full without assigning it to either speaker.
  if ([...overlap].some(([other, seconds]) => other !== voice && seconds > (other > 0 ? 0.25 : Math.max(0.5, (phrase.end - phrase.start) * 0.2)))) return { ...phrase, voice: null }
  const own = turns.filter(turn => turn.voice === voice && turn.end > phrase.start && turn.start < phrase.end)
  const start = Math.max(phrase.start, Math.min(...own.map(turn => turn.start))), end = Math.min(phrase.end, Math.max(...own.map(turn => turn.end)))
  return { ...phrase, start, end: Math.max(start, end), voice }
}

const words = (text: string): string[] => text.toLocaleLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean)

/** A microphone phrase that repeats what the system track says at the same moment is the speakers leaking into the microphone. */
function isEcho(phrase: Phrase, remote: Phrase[]): boolean {
  const own = words(phrase.text)
  if (!own.length) return true
  const pool = new Set<string>()
  for (const other of remote) if (other.end >= phrase.start - ECHO_WINDOW_SECONDS && other.start <= phrase.end + ECHO_WINDOW_SECONDS) for (const word of words(other.text)) pool.add(word)
  if (!pool.size) return false
  const shared = own.filter(word => pool.has(word)).length / own.length
  // Different people often say the same short greeting. Text alone cannot prove that is an echo.
  return own.length >= 3 && shared >= ECHO_WORD_RATIO
}

function merge(phrases: Spoken[]): Spoken[] {
  const merged: Spoken[] = []
  for (const phrase of [...phrases].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1]
    if (last && last.track === phrase.track && last.voice === phrase.voice && last.owner === phrase.owner && phrase.start - last.end <= FRAGMENT_MAX_GAP_SECONDS && last.text.length + phrase.text.length < FRAGMENT_MAX_CHARS) {
      last.text = `${last.text} ${phrase.text}`
      last.end = Math.max(last.end, phrase.end)
    } else merged.push({ ...phrase })
  }
  return merged
}

async function ownerParticipant(store: MemoryStore, row: RecordingRow): Promise<ImportInput["participants"][number] | null> {
  const invited = row.event?.attendees.find(attendee => attendee.self && attendee.email)
  const known = invited ? { email: invited.email!, name: invited.name ?? "" } : (await store.db.query<{ email: string | null; name: string | null }>(`SELECT a.value->>'email' AS email,a.value->>'displayName' AS name
    FROM entities e, json_each(e.data->'attendees') a WHERE e.kind='event' AND (a.value->>'self') IN (1,'true') AND a.value->>'email' IS NOT NULL
    ORDER BY e.updated_at DESC LIMIT 1`))[0]
  if (!known?.email) return null
  const email = known.email.toLowerCase()
  const person = (await store.db.query<{ title: string }>("SELECT title FROM entities WHERE kind='person' AND lower(data->>'email')=$1 AND (data->>'merged_into') IS NULL LIMIT 1", [email]))[0]
  return { external_id: `recording-owner:${email}`, name: person?.title || known.name || email, email, identity_verified: true }
}

export async function processRecording(store: MemoryStore, media: MediaRuntime, payload: { recording_id: string }, signal: AbortSignal, progress: Progress,
  naming?: { ai: MemoryAI; config: AIConfig }) {
  const row = (await store.db.query<RecordingRow>("SELECT * FROM recordings WHERE id=$1", [payload.recording_id]))[0]
  if (!row) return { skipped: "recording_missing" }
  if (row.audio_deleted_at) return { skipped: "audio_deleted" }
  await store.db.query("UPDATE recordings SET state='processing',error=NULL,updated_at=now() WHERE id=$1", [row.id])
  const temporary: string[] = []
  let engine: SpeechEngine | undefined
  try {
    await progress({ stage: "recording_models", source_title: row.title })
    check(media.decoder.installed(), "Descargá el decodificador de audio y video desde Ajustes", 409)
    const separable = await ensureInstalled(media.diarization, signal)
    engine = await ensureInstalled(media.speech_small, signal) ? media.speech_small : media.speech
    check(engine === media.speech_small || media.speech.installed(), "Descargá el modelo de transcripción desde Ajustes", 409)
    const processor = engine === media.speech_small ? "whisper-small-q8-v1" : "whisper-base-q8-v1"
    const language = (await mediaSettings(store)).language

    const ffmpeg = await media.decoder.executable("ffmpeg"), pcm: Partial<Record<RecordingTrack, string>> = {}
    const incomplete = new Set<RecordingTrack>()
    const interrupted: RecordingTrack[] = []
    for (const track of RECORDING_TRACKS) {
      const stored = row.tracks[track]
      if (!stored) continue
      await progress({ stage: "media_decode" })
      const output = join(row.directory, `${track}.f32`)
      temporary.push(output)
      if (stored.incomplete) incomplete.add(track)
      try {
        const gaps = await decode(ffmpeg, join(row.directory, stored.file), output, signal)
        check((await stat(output)).size >= 4, "La pista no contiene muestras de audio", 422)
        if (gaps) interrupted.push(track)
        pcm[track] = output
      } catch (error) {
        signal.throwIfAborted()
        // Una pista dañada no debe ocultar la otra. Se conservan ambos originales para recuperación manual.
        if (!(error instanceof MemoryError)) throw error
        incomplete.add(track)
      }
    }
    check(Object.keys(pcm).length > 0, "No se pudo recuperar audio de ninguna pista de la grabación", 422)
    const mediaWarnings: string[] = []
    if (incomplete.size) mediaWarnings.push(`La grabación está incompleta. Puede faltar audio de: ${[...incomplete].map(track => track === "mic" ? "micrófono" : "audio del sistema").join(", ")}.`)
    for (const track of interrupted) mediaWarnings.push(`Se detectó una interrupción en ${track === "mic" ? "el micrófono" : "el audio de la llamada"}. Se conservó el horario de las intervenciones.`)
    let warning = mediaWarnings.length ? mediaWarnings.join(" ") : null
    await progress({ media_warnings: mediaWarnings })

    const warn = async (message: string) => {
      mediaWarnings.push(message)
      warning = mediaWarnings.join(" ")
      await progress({ media_warnings: mediaWarnings })
    }
    let turns: VoiceTurn[] = [], voices: Voiceprint[] = []
    const speech: Partial<Record<RecordingTrack, SpeechRegion[]>> = {}
    if (separable) for (const track of RECORDING_TRACKS) {
      const path = pcm[track]
      if (!path) continue
      try { speech[track] = await detectSpeech(media.diarization, path, signal) }
      catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof MemoryError) || error.statusCode !== 422) throw error
        await warn(`Falló el detector de habla en ${track === "system" ? "la llamada" : "el micrófono"}. Se usa el nivel de audio para transcribir.`)
      }
    }
    const playbackInMic = Boolean(pcm.mic && pcm.system && await microphoneHasPlayback(pcm.mic, pcm.system, signal))
    if (playbackInMic) await warn("El micrófono también captó los parlantes. Las intervenciones que coinciden con la llamada requieren confirmar quién habló.")
    const separate = async (track: RecordingTrack, path: string) => {
      await progress({ stage: "diarization" })
      try {
        const result = await diarize(media.diarization, path, signal, speech[track])
        turns = result.turns; voices = result.voices
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof MemoryError) || error.statusCode !== 422) throw error
        turns = []; voices = []
        await warn(`No se pudieron separar las voces de ${track === "system" ? "la llamada" : "la pista de micrófono"}. Sus intervenciones quedan sin identificar.`)
      }
    }
    if (pcm.system && separable) await separate("system", pcm.system)

    const base = Date.parse(row.started_at), offsetOf = (track: RecordingTrack): number => (Date.parse(row.tracks[track]!.started_at) - base) / 1000
    const duration = (Date.parse(row.ended_at) - base) / 1000
    const report = (track: RecordingTrack) => (seconds: number) => progress({ stage: "transcription", media_seconds: Math.round(offsetOf(track) + seconds), media_duration_seconds: Math.round(duration) })
    // Phrases come back in track time; `placed` moves them to the recording timeline shared by both tracks.
    const placed = <T extends Phrase>(track: RecordingTrack, phrase: T): T => ({ ...phrase, start: phrase.start + offsetOf(track), end: phrase.end + offsetOf(track) })
    const remote: Spoken[] = pcm.system ? (await transcribeTrack(engine, pcm.system, language, signal,
      (start, end, samples) => turns.length ? turns.some(turn => Math.min(end, turn.end) - Math.max(start, turn.start) > 0.2) : hasSpeechEnergy(samples), report("system"), processor, turns, speech.system))
      .map(phrase => placed("system", { ...attribute(phrase, turns), track: "system" as const })) : []
    // Without remote speech the microphone is the only source (in-person meeting, call played on speakers, system audio
    // denied): it may hold several people, so it is split by voice like a remote track and nobody is assumed to be the owner.
    const call = remote.length > 0
    const heard = pcm.mic ? await transcribeTrack(engine, pcm.mic, language, signal, (_start, _end, samples) => hasSpeechEnergy(samples), report("mic"), processor, "silero-v1", speech.mic) : []
    await engine.unload()
    const local = call ? heard.filter(phrase => !isEcho(placed("mic", phrase), remote)) : heard
    if (!call && pcm.mic && separable && local.length) await separate("mic", pcm.mic)
    const isOwner = (phrase: Phrase): boolean => {
      if (!call) return false
      if (!playbackInMic) return true
      if (!speech.system) return false
      const placedMic = placed("mic", phrase)
      return !speech.system.some(region => region.end + offsetOf("system") + 0.5 > placedMic.start && region.start + offsetOf("system") - 0.5 < placedMic.end)
    }
    const ownPhrases = local.filter(isOwner)
    const own = pcm.mic && separable && ownPhrases.length ? await voiceprint(media.diarization, pcm.mic, ownPhrases.map(phrase => [phrase.start, phrase.end] as [number, number]), signal).catch(async error => {
      signal.throwIfAborted()
      if (!(error instanceof MemoryError) || error.statusCode !== 422) throw error
      await warn("No se pudo obtener la huella de voz del micrófono.")
      return null
    }) : null
    const spoken = merge([...remote, ...local.map(phrase => placed("mic", call ? { ...phrase, track: "mic" as const, voice: isOwner(phrase) ? 0 : null, owner: isOwner(phrase) } : { ...attribute(phrase, turns), track: "mic" as const }))])
    if (!spoken.length) {
      await store.db.query("UPDATE recordings SET state='ready',error=$2,updated_at=now() WHERE id=$1", [row.id, [warning, "No se detectó habla en la grabación"].filter(Boolean).join(" ")])
      return { stage: "complete", skipped: "no_speech", media_warnings: mediaWarnings }
    }

    await progress({ stage: "recording_ingest" })
    const owner = await ownerParticipant(store, row)
    const label = (voice: number): string => `Voz ${voice}`
    const fragments: ImportInput["fragments"] = spoken.map(phrase => {
      const mine = phrase.owner === true
      return {
        text: phrase.text,
        external_id: `${phrase.track}:${Math.round(phrase.start * 1000)}`,
        ...(mine && owner ? { speaker: owner.external_id } : {}),
        start_time: new Date(base + phrase.start * 1000).toISOString(),
        end_time: new Date(base + phrase.end * 1000).toISOString(),
        offset_ms: Math.round(phrase.start * 1000),
        metadata: { generated: "transcription", processor, end_offset_ms: Math.round(phrase.end * 1000), track: phrase.track, review_state: "pending",
          ...(mine ? { speaker_resolution: owner ? "recording_owner" : "unresolved", ...(owner ? {} : { voice_label: "Micrófono" }) }
            : { voice: phrase.voice, voice_label: phrase.voice === null ? "Voz sin identificar" : label(phrase.voice), speaker_resolution: "unresolved" }) },
      }
    })
    // A reprocessed recording keeps the decisions already taken: each voice inherits them from the stored voice with the same voiceprint.
    const decided = (((await store.db.query<{ speakers: StoredVoice[] }>("SELECT speakers FROM recordings WHERE id=$1", [row.id]))[0]?.speakers) ?? []).filter(voice => voice.status !== "self")
    const stored: StoredVoice[] = [
      ...(own ? [{ voice: 0, label: owner?.name ?? "Micrófono", seconds: ownPhrases.reduce((sum, phrase) => sum + phrase.end - phrase.start, 0), embedding: own, status: "self" as const }] : []),
      ...voices.filter(voice => spoken.some(phrase => phrase.voice === voice.voice)).map(voice => {
        const previous = decided.map(item => ({ item, similarity: cosine(item.embedding, voice.embedding) })).filter(match => match.similarity >= SAME_VOICE_SIMILARITY)
          .sort((a, b) => b.similarity - a.similarity)[0]?.item
        return { voice: voice.voice, label: previous?.status === "confirmed" ? previous.label : label(voice.voice), seconds: voice.seconds, embedding: voice.embedding,
          status: previous?.status ?? "unresolved" as const, ...(previous?.person_id ? { person_id: previous.person_id } : {}), ...(previous?.remember && previous.status === "confirmed" ? { remember: true } : {}) }
      }),
    ]
    const result = await store.ingest({
      provider: "manual", account: "local", external_id: `recording:${row.id}`, kind: "meeting", title: row.title, occurred_at: row.started_at,
      participants: call && owner ? [owner] : [], fragments,
      metadata: { recording_id: row.id, source_kind: "recording", capture: call ? "call" : "room", ended_at: row.ended_at, platform: row.event?.platform ?? null, tracks: Object.keys(pcm),
        ...(warning ? { recording_warning: warning } : {}),
        attendees: row.event?.attendees ?? [], voices: stored.filter(voice => voice.status !== "self").map(voice => ({ voice: voice.voice, label: voice.label, seconds: Math.round(voice.seconds) })),
        calendar_event: row.event ? { connector_id: row.event.connector_id, calendar: row.event.calendar, event_id: row.event.event_id } : null },
      original: { recording_id: row.id, processor, phrases: spoken },
    }, "recording")
    await store.db.transaction(async sql => {
      for (const voice of stored) if (voice.status === "confirmed" && voice.person_id) await assignVoice(sql, result.entity_id, result.version_id, voice.voice, voice.person_id)
      await sql.query("UPDATE recordings SET state='ready',error=$5,entity_id=$2,speakers=$3,audio_expires_at=ts($4),updated_at=now() WHERE id=$1",
        [row.id, result.entity_id, JSON.stringify(stored), expiry(await recordingSettings(store)), warning])
    })
    await linkRecordingEvents(store)
    // A failed proposal must not fail a recording that is already saved: voices simply stay unnamed.
    const windowHints = pcm.system && call ? await alignWindowHints(row.directory, base, offsetOf("system"), turns) : []
    const named = naming ? await progress({ stage: "voice_naming" }).then(() => proposeVoiceNames(store, naming.ai, naming.config, row.id, signal, windowHints))
      .catch(error => { if (signal.aborted) throw error; return { voice_proposals: 0, voice_naming: "failed" } }) : {}
    return { stage: "complete", entity_id: result.entity_id, version_id: result.version_id, fragments: fragments.length, voices: voices.length, processor, media_warnings: mediaWarnings, ...named }
  } catch (error) {
    if (!signal.aborted) await store.db.query("UPDATE recordings SET state='failed',error=$2,updated_at=now() WHERE id=$1",
      [row.id, error instanceof MemoryError ? error.message : "No se pudo procesar la grabación"]).catch(() => undefined)
    throw error
  } finally {
    await engine?.unload().catch(() => undefined)
    for (const path of temporary) await rm(path, { force: true }).catch(() => undefined)
  }
}

function cosine(a: number[], b: number[]): number {
  let sum = 0
  for (let index = 0; index < Math.min(a.length, b.length); index++) sum += a[index]! * b[index]!
  return sum
}

function expiry(settings: { retention_days: number }): string {
  return new Date(Date.now() + settings.retention_days * 86_400_000).toISOString()
}

/** Links processed recordings to their calendar event once the calendar sync has imported it. */
export async function linkRecordingEvents(store: MemoryStore): Promise<void> {
  const pending = await store.db.query<{ meeting: string; event: string }>(`SELECT r.entity_id AS meeting,s.entity_id AS event FROM recordings r
    JOIN sources s ON s.provider='google' AND s.account=r.event->>'connector_id' AND s.external_id='calendar:'||(r.event->>'calendar')||':'||(r.event->>'event_id')
    WHERE r.entity_id IS NOT NULL AND r.event IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM links l WHERE l.from_id=r.entity_id AND l.type='calendar_event')`)
  for (const row of pending) await store.link({ from_id: row.meeting, to_id: row.event, type: "calendar_event" }, "recording")
}
