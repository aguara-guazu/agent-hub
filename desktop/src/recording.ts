import { join } from "node:path"
import type { UpcomingEvent } from "./recording-offers.js"

/**
 * Grabación local de una reunión en dos pistas: `mic` (quien usa el Hub) y `system` (el resto de la llamada).
 *
 * El módulo es puro: no importa Electron. La ventana oculta que captura, el disco y el reloj entran por
 * `RecordingDeps`. Cada pista se escribe por tramos en `<root>/<id>/<pista>.webm` y `meta.json` guarda la hora
 * de reloj en que empezó cada una, que es lo que permite alinear las pistas entre sí y con otras grabaciones
 * de la misma reunión.
 */

export type RecordingTrack = "mic" | "system"
export type RecordingPhase = "idle" | "starting" | "recording" | "stopping"
export type RecordingError = "microphone_denied" | "capture_failed" | "storage_failed"
export type AutoStopReason = "limit" | "capture_lost" | "storage_failed"

export const RECORDING_TRACKS: readonly RecordingTrack[] = ["mic", "system"]
export const RECORDING_MAX_MS = 3 * 60 * 60_000
export const RECORDING_META_FILE = "meta.json"

export interface RecordingRequest {
  title: string
  calendarEvent?: UpcomingEvent
  matchCalendar?: boolean
  eventId?: string | null
  /** Fin programado del evento en ISO 8601; sólo sirve para recordar que la reunión terminó. */
  scheduledEnd?: string | null
}

export interface TrackMeta {
  file: string
  /** Hora de reloj del primer tramo en ISO 8601; `null` si la pista no llegó a abrirse. */
  started_at: string | null
  bytes: number
  /** La pista nunca llegó a abrirse. */
  error?: string
  /** La pista se abrió pero quedó incompleta. Se conserva todo el audio que llegó. */
  interrupted?: string
}

export interface RecordingMeta {
  schema: 1
  id: string
  title: string
  event_id: string | null
  scheduled_end: string | null
  calendar_event?: UpcomingEvent
  match_calendar_on_save?: boolean
  started_at: string
  ended_at: string | null
  tracks: Partial<Record<RecordingTrack, TrackMeta>>
  speaker_hints?: { at: number; name: string }[]
  app_version: string
  /** Se conserva lo recuperable, sin presentar la grabación como completa. */
  incomplete?: boolean
}

export interface RecordingState {
  phase: RecordingPhase
  id: string | null
  title: string | null
  eventId: string | null
  startedAt: string | null
  scheduledEnd: string | null
  error: RecordingError | null
}

export interface FinishedRecording {
  directory: string
  meta: RecordingMeta
}

export interface RecorderHandle {
  selectSpeakerWindow?(source?: "window" | "tab"): Promise<void>
  start(): void
  /** Pide el último tramo de cada pista y resuelve cuando la ventana lo entregó o venció la espera. */
  stop(): Promise<void>
  close(): void
}

export interface RecordingDeps {
  root: string
  appVersion: string
  now(): Date
  newId(): string
  microphoneAllowed(): Promise<boolean>
  openRecorder(): Promise<RecorderHandle>
  mkdir(path: string): Promise<void>
  append(path: string, data: Uint8Array): Promise<void>
  writeJson(path: string, value: unknown): Promise<void>
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  onChange(state: RecordingState): void
  /** Una pista dejó de grabar y la otra sigue. */
  onTrackLost(track: RecordingTrack): void
  /** La grabación se detuvo sola: llegó a `RECORDING_MAX_MS` o se quedó sin ninguna pista. */
  onAutoStop(reason: AutoStopReason, finished: FinishedRecording | null): void
  log(line: string): void
}

const IDLE: RecordingState = { phase: "idle", id: null, title: null, eventId: null, startedAt: null, scheduledEnd: null, error: null }

export class RecordingController {
  private current: RecordingState = IDLE
  private meta: RecordingMeta | null = null
  private directory: string | null = null
  private recorder: RecorderHandle | null = null
  private writes: Promise<void> = Promise.resolve()
  private limit: unknown = null
  private stopping: Promise<FinishedRecording | null> | null = null
  private generation = 0
  private storageFailed = false
  private failedTracks = new Set<RecordingTrack>()

  constructor(private readonly deps: RecordingDeps) {}

  get state(): RecordingState {
    return this.current
  }

  get active(): boolean {
    return this.current.phase !== "idle"
  }

  get calendarEvent(): UpcomingEvent | undefined { return this.meta?.calendar_event }

  requireCalendarChoice(id: string): void {
    if (this.meta?.id !== id || !this.meta.match_calendar_on_save) return
    delete this.meta.match_calendar_on_save
    this.enqueue(() => this.persist())
  }

  setCalendarEvent(id: string, event: UpcomingEvent | null, fallbackTitle: string): void {
    const meta = this.meta
    if (!meta || meta.id !== id || this.current.phase !== "recording") return
    if (JSON.stringify(meta.calendar_event ?? null) === JSON.stringify(event)) return
    if (event) meta.calendar_event = event
    else delete meta.calendar_event
    meta.title = event?.title || fallbackTitle
    meta.event_id = event?.event_id ?? null
    meta.scheduled_end = event?.end ?? null
    this.enqueue(() => this.persist())
    this.set({ ...this.current, title: meta.title, eventId: meta.event_id, scheduledEnd: meta.scheduled_end })
  }

  async start(request: RecordingRequest): Promise<RecordingState> {
    if (this.active) return this.current
    const generation = ++this.generation
    const cancelled = (): boolean => generation !== this.generation
    const id = this.deps.newId(), startedAt = this.deps.now().toISOString()
    const calendar = request.calendarEvent
    const base = { id, title: calendar?.title || request.title, eventId: calendar?.event_id ?? request.eventId ?? null, startedAt, scheduledEnd: calendar?.end ?? request.scheduledEnd ?? null }
    this.set({ ...base, phase: "starting", error: null })
    try {
      const allowed = await this.deps.microphoneAllowed()
      if (cancelled()) return IDLE
      if (!allowed) return this.fail("microphone_denied")
      const directory = join(this.deps.root, id)
      const meta: RecordingMeta = { schema: 1, id, title: base.title, event_id: base.eventId, scheduled_end: base.scheduledEnd, started_at: startedAt, ended_at: null, tracks: {}, app_version: this.deps.appVersion, ...(calendar ? { calendar_event: calendar } : {}) }
      await this.deps.mkdir(directory)
      if (request.matchCalendar) meta.match_calendar_on_save = true
      if (cancelled()) return IDLE
      await this.deps.writeJson(join(directory, RECORDING_META_FILE), meta)
      if (cancelled()) return IDLE
      const recorder = await this.deps.openRecorder()
      if (cancelled()) { recorder.close(); return IDLE }
      this.directory = directory
      this.meta = meta
      this.recorder = recorder
      this.storageFailed = false
      this.failedTracks.clear()
      this.recorder.start()
    } catch (error) {
      if (cancelled()) return IDLE
      this.deps.log(`[recording] no pudo iniciar: ${error instanceof Error ? error.message : String(error)}`)
      return this.fail("capture_failed")
    }
    this.limit = this.deps.setTimer(() => { void this.stop().then(finished => this.deps.onAutoStop("limit", finished)) }, RECORDING_MAX_MS)
    this.set({ ...base, phase: "recording", error: null })
    return this.current
  }

  speakerObserved(id: string, at: number, name: string): void {
    if (this.current.phase !== "recording" || this.meta?.id !== id || !Number.isFinite(at)) return
    const hints = this.meta.speaker_hints ??= []
    const last = hints.at(-1)
    if (hints.length < 12000 && (!last || last.name !== name || at - last.at >= 10000)) hints.push({ at, name })
  }

  async selectSpeakerWindow(source: "window" | "tab" = "window"): Promise<void> {
    if (this.current.phase === "recording") await this.recorder?.selectSpeakerWindow?.(source)
  }

  trackStarted(track: RecordingTrack, epochMs: number): void {
    if (!this.meta) return
    this.meta.tracks[track] = { file: `${track}.webm`, started_at: new Date(epochMs).toISOString(), bytes: 0 }
    this.deps.log(`[recording] pista ${track} abierta`)
    this.enqueue(() => this.persist())
  }

  trackFailed(track: RecordingTrack, message: string): void {
    // Al cerrar la ventana de captura sus pistas "terminan": eso no es una falla de una grabación que ya se está deteniendo.
    if (!this.meta || this.stopping) return
    const existing = this.meta.tracks[track], detail = message.slice(0, 300)
    if (existing?.interrupted || existing?.error) return
    if (existing?.started_at) existing.interrupted = detail
    else this.meta.tracks[track] = { file: `${track}.webm`, started_at: null, bytes: 0, error: detail }
    this.deps.log(`[recording] pista ${track} ${existing?.started_at ? "se cortó" : "no abrió"}: ${message}`)
    this.enqueue(() => this.persist())
    // Una pista que todavía no informó cuenta como viva: al iniciar, las dos avisan con segundos de diferencia.
    const alive = RECORDING_TRACKS.some(name => { const entry = this.meta?.tracks[name]; return !entry || (!entry.error && !entry.interrupted) })
    if (this.current.phase !== "recording") return
    if (alive) this.deps.onTrackLost(track)
    else void this.stop().then(finished => this.deps.onAutoStop("capture_lost", finished))
  }

  chunk(track: RecordingTrack, data: Uint8Array): void {
    const entry = this.meta?.tracks[track], directory = this.directory
    if (!entry || entry.error || !directory || !data.byteLength) return
    this.enqueue(async () => {
      // Una escritura parcial puede haber roto el contenedor: no se le agregan tramos posteriores.
      if (this.failedTracks.has(track)) return
      try {
        await this.deps.append(join(directory, entry.file), data)
        entry.bytes += data.byteLength
      } catch (error) {
        this.failedTracks.add(track)
        entry.interrupted = "audio write failed"
        throw error
      }
    })
  }

  /** Detiene la captura y devuelve la grabación si alguna pista dejó audio. Varias llamadas comparten la misma parada. */
  stop(): Promise<FinishedRecording | null> {
    if (this.stopping) return this.stopping
    if (this.current.phase === "starting") {
      // Los recursos del arranque son locales: una respuesta tardía se descarta y cierra allí.
      ++this.generation
      this.set(IDLE)
      return Promise.resolve(null)
    }
    if (this.current.phase !== "recording") return Promise.resolve(null)
    this.stopping = Promise.resolve().then(() => this.finish()).finally(() => { this.stopping = null })
    this.set({ ...this.current, phase: "stopping" })
    return this.stopping
  }

  private async finish(): Promise<FinishedRecording | null> {
    this.deps.clearTimer(this.limit)
    this.limit = null
    const recorder = this.recorder, meta = this.meta, directory = this.directory
    try {
      await recorder?.stop()
    } catch (error) {
      if (meta) meta.incomplete = true
      this.deps.log(`[recording] la ventana de captura no confirmó la parada: ${error instanceof Error ? error.message : String(error)}`)
    }
    recorder?.close()
    await this.writes
    if (meta) {
      meta.ended_at = this.deps.now().toISOString()
      for (const track of Object.values(meta.tracks)) {
        if (track.started_at && track.bytes === 0 && !track.error) track.interrupted ??= "no audio samples received"
        if (track.error || track.interrupted) meta.incomplete = true
      }
      await this.persist().catch(error => this.writeFailed(error))
    }
    this.recorder = null
    this.meta = null
    this.directory = null
    this.writes = Promise.resolve()
    this.set({ ...IDLE, error: this.storageFailed ? "storage_failed" : null })
    const recorded = meta && Object.values(meta.tracks).some(track => track.bytes > 0)
    return meta && directory && recorded ? { directory, meta } : null
  }

  private fail(error: RecordingError): RecordingState {
    this.recorder?.close()
    this.recorder = null
    this.meta = null
    this.directory = null
    this.set({ ...IDLE, error })
    return this.current
  }

  private persist(): Promise<void> {
    if (!this.meta || !this.directory) return Promise.resolve()
    return this.deps.writeJson(join(this.directory, RECORDING_META_FILE), this.meta)
  }

  /** Las escrituras de una grabación van en orden: un tramo nunca adelanta al anterior de su pista. */
  private enqueue(task: () => Promise<void>): void {
    this.writes = this.writes.then(task).catch(error => this.writeFailed(error))
  }

  private writeFailed(error: unknown): void {
    this.deps.log(`[recording] escritura fallida: ${error instanceof Error ? error.message : String(error)}`)
    if (this.meta) this.meta.incomplete = true
    if (this.storageFailed) return
    this.storageFailed = true
    if (!this.stopping) void this.stop().then(finished => this.deps.onAutoStop("storage_failed", finished))
  }

  private set(state: RecordingState): void {
    this.current = state
    this.deps.onChange(state)
  }
}
