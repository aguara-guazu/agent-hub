import { join } from "node:path"

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
export type RecordingError = "microphone_denied" | "capture_failed"

export const RECORDING_TRACKS: readonly RecordingTrack[] = ["mic", "system"]
export const RECORDING_MAX_MS = 3 * 60 * 60_000
export const RECORDING_META_FILE = "meta.json"

export interface RecordingRequest {
  title: string
  eventId?: string | null
  /** Fin programado del evento en ISO 8601; sólo sirve para recordar que la reunión terminó. */
  scheduledEnd?: string | null
}

export interface TrackMeta {
  file: string
  /** Hora de reloj del primer tramo en ISO 8601; `null` si la pista no llegó a abrirse. */
  started_at: string | null
  bytes: number
  error?: string
}

export interface RecordingMeta {
  schema: 1
  id: string
  title: string
  event_id: string | null
  scheduled_end: string | null
  started_at: string
  ended_at: string | null
  tracks: Partial<Record<RecordingTrack, TrackMeta>>
  app_version: string
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
  /** La grabación llegó a `RECORDING_MAX_MS` y se detuvo. */
  onLimit(finished: FinishedRecording | null): void
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

  constructor(private readonly deps: RecordingDeps) {}

  get state(): RecordingState {
    return this.current
  }

  get active(): boolean {
    return this.current.phase !== "idle"
  }

  async start(request: RecordingRequest): Promise<RecordingState> {
    if (this.active) return this.current
    const id = this.deps.newId(), startedAt = this.deps.now().toISOString()
    const base = { id, title: request.title, eventId: request.eventId ?? null, startedAt, scheduledEnd: request.scheduledEnd ?? null }
    this.set({ ...base, phase: "starting", error: null })
    try {
      if (!await this.deps.microphoneAllowed()) return this.fail("microphone_denied")
      this.directory = join(this.deps.root, id)
      this.meta = { schema: 1, id, title: request.title, event_id: base.eventId, scheduled_end: base.scheduledEnd, started_at: startedAt, ended_at: null, tracks: {}, app_version: this.deps.appVersion }
      await this.deps.mkdir(this.directory)
      await this.persist()
      this.recorder = await this.deps.openRecorder()
      this.recorder.start()
    } catch (error) {
      this.deps.log(`[recording] no pudo iniciar: ${error instanceof Error ? error.message : String(error)}`)
      return this.fail("capture_failed")
    }
    this.limit = this.deps.setTimer(() => { void this.stop().then(finished => this.deps.onLimit(finished)) }, RECORDING_MAX_MS)
    this.set({ ...base, phase: "recording", error: null })
    return this.current
  }

  trackStarted(track: RecordingTrack, epochMs: number): void {
    if (!this.meta) return
    this.meta.tracks[track] = { file: `${track}.webm`, started_at: new Date(epochMs).toISOString(), bytes: 0 }
    this.deps.log(`[recording] pista ${track} abierta`)
    this.enqueue(() => this.persist())
  }

  trackFailed(track: RecordingTrack, message: string): void {
    if (!this.meta) return
    this.meta.tracks[track] = { file: `${track}.webm`, started_at: null, bytes: 0, error: message.slice(0, 300) }
    this.deps.log(`[recording] pista ${track} falló: ${message}`)
    this.enqueue(() => this.persist())
    const failed = RECORDING_TRACKS.every(name => this.meta?.tracks[name]?.error)
    if (failed && this.current.phase === "recording") void this.stop().then(() => this.set({ ...IDLE, error: "capture_failed" }))
  }

  chunk(track: RecordingTrack, data: Uint8Array): void {
    const entry = this.meta?.tracks[track], directory = this.directory
    if (!entry || entry.error || !directory || !data.byteLength) return
    entry.bytes += data.byteLength
    this.enqueue(() => this.deps.append(join(directory, entry.file), data))
  }

  /** Detiene la captura y devuelve la grabación si alguna pista dejó audio. Varias llamadas comparten la misma parada. */
  stop(): Promise<FinishedRecording | null> {
    if (this.stopping) return this.stopping
    if (this.current.phase !== "recording") return Promise.resolve(null)
    this.set({ ...this.current, phase: "stopping" })
    this.stopping = this.finish().finally(() => { this.stopping = null })
    return this.stopping
  }

  private async finish(): Promise<FinishedRecording | null> {
    this.deps.clearTimer(this.limit)
    this.limit = null
    const recorder = this.recorder, meta = this.meta, directory = this.directory
    try {
      await recorder?.stop()
    } catch (error) {
      this.deps.log(`[recording] la ventana de captura no confirmó la parada: ${error instanceof Error ? error.message : String(error)}`)
    }
    recorder?.close()
    await this.writes
    if (meta) {
      meta.ended_at = this.deps.now().toISOString()
      await this.persist().catch(error => this.deps.log(`[recording] no se pudo guardar meta.json: ${error instanceof Error ? error.message : String(error)}`))
    }
    this.recorder = null
    this.meta = null
    this.directory = null
    this.writes = Promise.resolve()
    this.set(IDLE)
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
    this.writes = this.writes.then(task).catch(error => this.deps.log(`[recording] escritura fallida: ${error instanceof Error ? error.message : String(error)}`))
  }

  private set(state: RecordingState): void {
    this.current = state
    this.deps.onChange(state)
  }
}
