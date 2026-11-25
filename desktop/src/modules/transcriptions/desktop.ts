import { randomUUID } from 'node:crypto'
import { CalendarEndReminder, type EndNotice } from "./calendar-end-reminder.js"
import { showCalendarEndNotice } from "./calendar-end-notice.js"
import { appendFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app, ipcMain, Menu, Notification, powerSaveBlocker, systemPreferences } from 'electron'

import type { resolvePaths } from '../../paths.js'
import type { TrayAction } from '../../tray.js'
import { activeLanguage, t } from "../../i18n.js"
import { IPC, type RecordingStatusView } from '../../ipc.js'
import {
  RECORDING_META_FILE, RECORDING_TRACKS, RecordingController, type FinishedRecording,
  type RecordingMeta, type RecordingRequest, type RecordingState, type RecordingTrack,
} from "./recording.js"
import { openRecorderWindow } from "./recorder-window.js"
import { RecordingOffers, type UpcomingEvent, type UpcomingResponse } from "./recording-offers.js"
import { writeJsonDurable } from '../../update-transaction.js'

interface RecordingHost {
  stateDir: string
  paths: Pick<ReturnType<typeof resolvePaths>, 'recorderPreloadPath' | 'recorderPagePath'>
  log(line: string): void
  showRetained(notice: Notification): void
  openRoute(route: string): void
  liveNotifications: readonly Notification[]
  refreshTray(): void
  coreFetch(path: string, init?: RequestInit): Promise<Response>
  broadcast(status: RecordingStatusView): void
  isQuitting(): boolean
  isCoreRunning(): boolean
  setTrayTitle(title: string): void
}

export function createDesktopRecording(host: RecordingHost) {
  const { stateDir, paths, showRetained, openRoute, liveNotifications, refreshTray, coreFetch } = host
  const RECORDING_SUPPORTED = ["darwin", "win32", "linux"].includes(process.platform)
  const recordingsDir = join(stateDir, "recordings")
  /** Evento del calendario de una grabación, guardado junto al audio para que el core conozca invitados y horario. */
  const RECORDING_EVENT_FILE = "event.json"
  let recordingAwake: number | null = null

  async function microphoneAllowed(): Promise<boolean> {
    if (process.platform !== "darwin") return true
    const status = systemPreferences.getMediaAccessStatus("microphone")
    if (status === "granted") return true
    // Con firma ad hoc cada versión nueva vuelve a `not-determined`: el sistema pregunta otra vez.
    return status === "not-determined" ? await systemPreferences.askForMediaAccess("microphone") : false
  }

  const recording = new RecordingController({
    root: recordingsDir,
    appVersion: app.getVersion(),
    now: () => new Date(),
    newId: () => randomUUID(),
    microphoneAllowed,
    openRecorder: () => openRecorderWindow({ preload: paths.recorderPreloadPath, page: paths.recorderPagePath }, {
      onTrackStarted: (track, epochMs) => recording.trackStarted(track, epochMs),
      onTrackFailed: (track, message) => recording.trackFailed(track, message),
      onChunk: (track, data) => recording.chunk(track, data),
      speakerModelDirectory: process.env.AGENTHUB_MEMORY_DIR || join(stateDir, "memory"),
      onSpeaker: (at, name) => { if (recording.state.id) recording.speakerObserved(recording.state.id, at, name) },
      onVisualError: () => notifyRecording(t("tray.recordWindow"), t("recording.noWindow")),
      onVisualOpportunity: offerVisualSource,
      onLevels: levels => {
        if (Object.values(levels).some(level => (level ?? 0) > RECORDING_SILENCE_RMS)) recordingHeardAt = Date.now()
        if ((levels.system ?? 0) > RECORDING_SILENCE_RMS) recordingRemoteHeardAt = Date.now()
        if ((levels.system ?? 0) > RECORDING_DIGITAL_SILENCE) recordingSystemSilentSince = 0
      },
    }),
    mkdir: async path => { await mkdir(path, { recursive: true, mode: 0o700 }) },
    append: (path, data) => appendFile(path, data, { mode: 0o600 }),
    writeJson: async (path, value) => { writeJsonDurable(path, value) },
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
    onChange: state => onRecordingChange(state),
    onTrackLost: track => notifyRecording(t("recording.trackLostTitle"), t(track === "mic" ? "recording.micLostBody" : process.platform === "linux" ? "recording.linuxSystemLost" : "recording.systemLostBody")),
    onAutoStop: (reason, finished) => {
      if (reason === "storage_failed") { void recordingFinished(finished); return }
      if (reason === "limit") notifyRecording(t("recording.limitTitle"), t("recording.limitBody"))
      else if (finished) notifyRecording(t("recording.captureLostTitle"), t("recording.captureLostBody"))
      else { notifyRecording(t("recording.failedTitle"), t("recording.failedBody")); return }
      void recordingFinished(finished)
    },
    log: line => host.log(line),
  })

  const recordingOffers = new RecordingOffers()
  const recordingNotifications = new WeakSet<Notification>()
  let recordingPreferenceRevision = 0

  function showRecordingNotification(notice: Notification): void {
    recordingNotifications.add(notice)
    showRetained(notice)
  }

  function notifyRecording(title: string, body: string, openHome = false): void {
    if (!recordingOffers.enabled || !Notification.isSupported()) return
    try {
      const notice = new Notification({ title, body })
      if (openHome) notice.on("click", () => { if (recordingOffers.enabled) openRoute("/home") })
      showRecordingNotification(notice)
    } catch { /* The native notification service can be unavailable. */ }
  }

  function applyRecordingEnabled(enabled: boolean): void {
    if (recordingOffers.enabled === enabled) return
    ++recordingPreferenceRevision
    recordingOffers.setEnabled(enabled)
    if (!enabled) {
      if (recording.state.phase === "recording" || recording.state.phase === "starting") void stopRecording()
      calendarEndReminder.clear()
      closeSilenceNotice()
      for (const notice of liveNotifications) if (recordingNotifications.has(notice)) {
        try { notice.close() } catch { /* The notification center may have dismissed it already. */ }
      }
      calendarRequiresChoice = false
    }
    refreshTray()
    broadcastRecording()
  }

  async function refreshRecordingEnabled(): Promise<void> {
    const revision = recordingPreferenceRevision
    try {
      const response = await coreFetch("/api/memory/recordings/settings")
      if (response.ok) {
        const settings = await response.json() as { enabled?: boolean }
        if (revision === recordingPreferenceRevision) applyRecordingEnabled(settings.enabled ?? true)
      }
    } catch { /* Offline, keep the last known setting. A fresh process starts with capture disabled. */ }
  }

  async function setRecordingEnabled(enabled: unknown): Promise<void> {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid recording setting")
    const response = await coreFetch("/api/memory/recordings/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) })
    if (!response.ok) throw new Error(`Recording settings: HTTP ${response.status}`)
    const saved = await response.json() as { enabled: boolean }
    ++recordingPreferenceRevision // Invalidate a calendar read started before the setting was saved.
    applyRecordingEnabled(saved.enabled)
    if (saved.enabled) void pollRecordingOffers()
  }

  function offerVisualSource(): void {
    const id = recording.state.id
    if (!recordingOffers.enabled || !id || !Notification.isSupported()) return
    const select = (source: "tab" | "window") => {
      if (recording.state.id !== id || recording.state.phase !== "recording") return
      void recording.selectSpeakerWindow(source).catch(() => notifyRecording(t("recording.visualTitle"), t("recording.noWindow")))
    }
    try {
      const notice = new Notification({ title: t("recording.visualTitle"), body: t("recording.visualHint"), silent: true })
      notice.on("click", () => {
        if (recording.state.id !== id || recording.state.phase !== "recording") return
        Menu.buildFromTemplate([
          { label: t("tray.recordTab"), click: () => select("tab") },
          { label: t("tray.recordWindow"), click: () => select("window") },
        ]).popup()
      })
      showRecordingNotification(notice)
    } catch { /* The same two choices remain available in the tray. */ }
  }
  const RECORDING_OFFERS_POLL_MS = 30_000
  const RECORDING_TICK_MS = 15_000
  /** Por debajo de este RMS una pista se considera en silencio. */
  const RECORDING_SILENCE_RMS = 0.003
  const RECORDING_SILENCE_REMIND_MS = 5 * 60_000
  const RECORDING_SILENCE_REPEAT_MS = 10 * 60_000
  let recordingHeardAt = 0
  let recordingRemoteHeardAt = 0
  let silenceNotice: EndNotice | undefined
  function closeSilenceNotice(): void { silenceNotice?.close(); silenceNotice = undefined }
  let calendarRequiresChoice = false
  const calendarEndReminder = new CalendarEndReminder(() => recording.state, (title, decide) => {
    closeSilenceNotice()
    return showCalendarEndNotice(title, choice => {
      if (choice === "continue") recordingSilenceRemindedAt = Date.now()
      decide(choice)
    })
  }, () => { void stopRecording() },
  error => host.log(`[recording] no se pudo mostrar el aviso de fin programado: ${String(error)}`))
  let recordingSilenceRemindedAt = 0
  /** Una pista del sistema sin permiso se abre igual y entrega ceros exactos; por encima de este nivel hay señal real. */
  const RECORDING_DIGITAL_SILENCE = 0.00001
  const RECORDING_SYSTEM_SILENT_MS = 2 * 60_000
  /** Desde cuándo la pista del sistema sólo entrega ceros; 0 si ya llegó señal o ya se avisó. */
  let recordingSystemSilentSince = 0
  let lastRecordingBroadcast = ""

  function recordingStatus(): RecordingStatusView {
    const state = recording.state
    const choices = state.phase === "recording" ? recordingOffers.matchAt(Date.parse(state.startedAt!)) : []
    return {
      supported: RECORDING_SUPPORTED, enabled: recordingOffers.enabled, phase: state.phase, title: state.title, startedAt: state.startedAt, error: state.error,
      ...(state.id && state.phase === "recording" && (choices.length || recording.calendarEvent) ? {
        calendar: { recordingId: state.id, linked: !!recording.calendarEvent, choices: choices.map(event => ({ key: event.key, title: event.title, start: event.start! })) },
      } : {}),
      offers: recording.active ? [] : recordingOffers.open(Date.now()).map(event => ({ key: event.key, title: event.title, start: event.start!, end: event.end,
        platform: event.platform, attendees: event.attendees.filter(attendee => !attendee.self).length })),
    }
  }

  /** Sólo emite cuando algo cambió: el ciclo de 15 s no debe volver a dibujar Inicio en vano. */
  function broadcastRecording(): void {
    const status = recordingStatus(), serialized = JSON.stringify(status)
    if (serialized === lastRecordingBroadcast) return
    lastRecordingBroadcast = serialized
    host.broadcast(status)
  }

  const clockTime = (instant: string): string => new Intl.DateTimeFormat(activeLanguage(), { timeStyle: "short" }).format(new Date(instant))

  /** Avisa las ofertas que abren ahora y recuerda una grabación que quedó corriendo; nunca la detiene. */
  function recordingTick(): void {
    if (!RECORDING_SUPPORTED || !recordingOffers.enabled || host.isQuitting()) return
    const now = Date.now(), state = recording.state
    if (!recording.active) for (const event of recordingOffers.due(now)) notifyRecording(
      t("recording.offerTitle", { title: event.title || t("recording.untitled") }),
      event.platform ? t("recording.offerBodyPlatform", { time: clockTime(event.start!), platform: event.platform }) : t("recording.offerBody", { time: clockTime(event.start!) }), true,
    )
    if (state.phase === "recording") {
      const title = state.title ?? t("recording.untitled")
      calendarEndReminder.sync()
      const silent = now - (recordingRemoteHeardAt || recordingHeardAt) >= RECORDING_SILENCE_REMIND_MS
      if (!silent) closeSilenceNotice()
      if (silent && !calendarEndReminder.visible && (!silenceNotice || silenceNotice.isClosed?.()) && now - recordingSilenceRemindedAt >= RECORDING_SILENCE_REPEAT_MS) {
        try {
          const shown = showCalendarEndNotice(title, choice => {
            if (silenceNotice !== shown || recording.state.id !== state.id || recording.state.phase !== "recording") return
            recordingSilenceRemindedAt = Date.now()
            closeSilenceNotice()
            if (choice === "stop") void stopRecording()
          }, recordingRemoteHeardAt ? "remoteSilence" : "silence")
          silenceNotice = shown
        } catch (error) { host.log(`[recording] no se pudo mostrar el recordatorio de silencio: ${String(error)}`) }
      }
      if (recordingSystemSilentSince && now - recordingSystemSilentSince > RECORDING_SYSTEM_SILENT_MS) {
        recordingSystemSilentSince = 0
        notifyRecording(t("recording.systemSilentTitle"), t("recording.systemSilentBody"))
      }
    }
    broadcastRecording()
  }

  let recordingOffersPoll: Promise<void> | null = null
  function pollRecordingOffers(): Promise<void> {
    if (!RECORDING_SUPPORTED || host.isQuitting() || !host.isCoreRunning()) return Promise.resolve()
    recordingOffersPoll ??= (async () => {
      try {
        const revision = recordingPreferenceRevision
        const response = await coreFetch("/api/memory/recordings/upcoming")
        if (response.ok) {
          const snapshot = await response.json() as UpcomingResponse
          if (revision !== recordingPreferenceRevision) {
            if (recordingOffers.enabled) setTimeout(() => void pollRecordingOffers(), 0).unref()
            return
          }
          applyRecordingEnabled(snapshot.settings?.enabled ?? true)
          recordingOffers.update(snapshot)
          if (recordingOffers.enabled) syncRecordingCalendar()
        }
      } catch {
        // Con el core caído se conservan las últimas ofertas conocidas.
      }
      recordingTick()
    })().finally(() => { recordingOffersPoll = null })
    return recordingOffersPoll
  }

  function syncRecordingCalendar(): void {
    const { id, phase, startedAt } = recording.state
    if (!id || !startedAt || phase !== "recording") return
    const current = recording.calendarEvent
    const choices = recordingOffers.matchAt(Date.parse(startedAt))
    const fallback = manualRecordingTitle(new Date(startedAt))
    if (current) {
      const fresh = recordingOffers.get(current.key)
      if (!fresh && !recordingOffers.verifiedCalendar(current)) return
      if (fresh && (calendarRequiresChoice || (choices.length === 1 && choices[0]?.key === current.key))) {
        recording.setCalendarEvent(id, fresh, fallback)
        return
      }
      recording.setCalendarEvent(id, null, fallback)
    }
    if (calendarRequiresChoice) return
    if (choices.length === 1) recording.setCalendarEvent(id, choices[0]!, fallback)
    if (choices.length > 1) {
      calendarRequiresChoice = true
      recording.requireCalendarChoice(id)
      notifyRecording(t("recording.chooseCalendar"), t("recording.chooseCalendarBody"), true)
    }
  }

  function chooseRecordingCalendar(id: unknown, key: unknown): void {
    const state = recording.state
    if (typeof id !== "string" || id !== state.id || state.phase !== "recording" || !state.startedAt) return
    const choices = recordingOffers.matchAt(Date.parse(state.startedAt))
    const event = key === null ? null : choices.find(choice => choice.key === key)
    if (event === undefined) return
    calendarRequiresChoice = true
    recording.requireCalendarChoice(id)
    recording.setCalendarEvent(id, event, manualRecordingTitle(new Date(state.startedAt)))
    broadcastRecording()
  }

  async function startManualRecording(): Promise<void> {
    if (recording.active) return
    const choices = recordingOffers.matchAt(Date.now())
    const event = choices.length === 1 ? choices[0] : undefined
    const state = await startRecording({ title: manualRecordingTitle(), matchCalendar: true, ...(event ? { calendarEvent: event } : {}) })
    if (state.phase !== "recording") return
    syncRecordingCalendar()
    void pollRecordingOffers()
  }

  async function startOfferedRecording(key: string): Promise<void> {
    const event = recordingOffers.get(key)
    if (!event || recording.active) return
    calendarRequiresChoice = true
    const state = await startRecording({ title: manualRecordingTitle(), calendarEvent: event })
    if (state.phase !== "recording" || !state.id) return
    recordingOffers.accept(key)
    broadcastRecording()
  }

  function onRecordingChange(state: RecordingState): void {
    const active = state.phase !== "idle"
    if (!active) calendarRequiresChoice = false
    if (state.phase !== "recording") closeSilenceNotice()
    if (state.phase === "starting") { recordingHeardAt = Date.now(); recordingRemoteHeardAt = 0; recordingSilenceRemindedAt = 0; recordingSystemSilentSince = Date.now() }
    calendarEndReminder.sync()
    if (active && recordingAwake === null) recordingAwake = powerSaveBlocker.start("prevent-app-suspension")
    if (!active && recordingAwake !== null) { powerSaveBlocker.stop(recordingAwake); recordingAwake = null }
    if (process.platform === "darwin") host.setTrayTitle(active ? "●" : "")
    refreshTray()
    broadcastRecording()
  }

  async function startRecording(request: RecordingRequest): Promise<RecordingState> {
    if (!RECORDING_SUPPORTED || host.isQuitting() || !recordingOffers.enabled) return recording.state
    await refreshRecordingEnabled()
    if (!recordingOffers.enabled || host.isQuitting()) return recording.state
    const state = await recording.start(request)
    if (state.error === "microphone_denied") notifyRecording(t("recording.micDeniedTitle"), t("recording.micDeniedBody"))
    else if (state.error === "capture_failed") notifyRecording(t("recording.failedTitle"), t("recording.failedBody"))
    return state
  }

  async function stopRecording(): Promise<void> {
    const cancelling = recording.state.phase === "starting"
    const finished = await recording.stop()
    if (!cancelling) await recordingFinished(finished)
  }

  async function recordingFinished(finished: FinishedRecording | null): Promise<void> {
    const storageFailed = recording.state.error === "storage_failed"
    if (storageFailed) notifyRecording(t("recording.storageFailedTitle"), t("recording.storageFailedBody"))
    if (!finished) { if (!storageFailed) notifyRecording(t("recording.emptyTitle"), t("recording.emptyBody")); return }
    const minutes = Math.max(1, Math.round((Date.parse(finished.meta.ended_at ?? finished.meta.started_at) - Date.parse(finished.meta.started_at)) / 60_000))
    host.log(`[recording] guardada ${finished.meta.id} (${minutes} min) en ${finished.directory}`)
    if (!storageFailed) notifyRecording(t(finished.meta.incomplete ? "recording.incompleteTitle" : "recording.savedTitle"),
      t(finished.meta.incomplete ? "recording.incompleteBody" : "recording.savedBody", { title: finished.meta.title, minutes }))
    await submitRecordings()
  }

  const RECORDING_SUBMIT_RETRY_MS = 5 * 60_000
  const RECORDING_DIRECTORY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  /** Sufijo de una grabación que el core rechazó de forma definitiva: se conserva para recuperarla a mano y no se reintenta. */
  const RECORDING_REJECTED = ".rejected"
  const RECORDING_REJECTED_KEEP_MS = 30 * 86_400_000

  interface RecordedTrack { track: RecordingTrack; born: number; written: number }

  async function recordedTracks(directory: string): Promise<RecordedTrack[]> {
    const found: RecordedTrack[] = []
    for (const track of RECORDING_TRACKS) {
      const file = await stat(join(directory, `${track}.webm`)).catch(() => null)
      if (file?.size) found.push({ track, born: file.birthtimeMs, written: file.mtimeMs })
    }
    return found
  }

  /** `meta.json` de una grabación; si un cierre inesperado lo dejó ilegible se reconstruye con las fechas de los archivos de audio. */
  async function readRecordingMeta(directory: string, id: string, tracks: RecordedTrack[]): Promise<RecordingMeta> {
    const stored = await readFile(join(directory, RECORDING_META_FILE), "utf8").then(text => JSON.parse(text) as RecordingMeta).catch(() => null)
    if (stored?.id === id && stored.started_at && stored.tracks) return stored
    const first = Math.min(...tracks.map(item => item.born))
    return { schema: 1, id, title: manualRecordingTitle(new Date(first)), event_id: null, scheduled_end: null, started_at: new Date(first).toISOString(), ended_at: null,
      tracks: Object.fromEntries(tracks.map(item => [item.track, { file: `${item.track}.webm`, started_at: new Date(item.born).toISOString(), bytes: 0 }])), app_version: app.getVersion(), incomplete: true }
  }

  function postRecording(directory: string, event: unknown): Promise<Response> {
    return coreFetch("/api/memory/recordings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ directory, ...(event ? { event } : {}) }) })
  }

  /**
   * Entrega al core cada grabación terminada que sigue en `recordingsDir`; el core copia el audio a la memoria y borra la carpeta.
   * Una grabación sin `ended_at` quedó a medias por un cierre inesperado: se cierra con la hora de su último tramo escrito.
   * Corre al terminar una grabación, al arrancar y cada `RECORDING_SUBMIT_RETRY_MS`, así una entrega fallida (core caído) se reintenta sola.
   * Un rechazo definitivo del core no se reintenta: la carpeta se aparta con `RECORDING_REJECTED` y se avisa a la persona.
   */
  let submittingRecordings: Promise<void> | null = null
  function submitRecordings(): Promise<void> {
    submittingRecordings ??= (async () => {
      for (const name of await readdir(recordingsDir).catch(() => [] as string[])) {
        const directory = join(recordingsDir, name)
        if (name.endsWith(RECORDING_REJECTED)) {
          const info = await stat(directory).catch(() => null)
          if (info && Date.now() - info.mtimeMs > RECORDING_REJECTED_KEEP_MS) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
          continue
        }
        if (!RECORDING_DIRECTORY.test(name) || name === recording.state.id) continue
        try {
          const tracks = await recordedTracks(directory)
          if (!tracks.length) { await rm(directory, { recursive: true, force: true }); continue }
          const meta = await readRecordingMeta(directory, name, tracks)
          if (!meta.ended_at) { meta.incomplete = true; meta.ended_at = new Date(Math.max(...tracks.map(item => item.written))).toISOString() }
          if (!meta.calendar_event && meta.match_calendar_on_save) {
            await pollRecordingOffers()
            const choices = recordingOffers.matchAt(Date.parse(meta.started_at))
            if (choices.length === 1) {
              const event = choices[0]!
              meta.calendar_event = event; meta.event_id = event.event_id; meta.scheduled_end = event.end
              if (event.title) meta.title = event.title
            }
          }
          writeJsonDurable(join(directory, RECORDING_META_FILE), meta)
          const event = meta.calendar_event ? storedRecordingEvent(meta.calendar_event) :
            await readFile(join(directory, RECORDING_EVENT_FILE), "utf8").then(text => JSON.parse(text) as unknown).catch(() => undefined)
          let response = await postRecording(directory, event)
          // Un evento que el core no acepta no debe costar la grabación: se entrega sin invitados ni vínculo al calendario.
          if (event && response.status === 422) response = await postRecording(directory, undefined)
          host.log(`[recording] entrega de ${name}: HTTP ${response.status}`)
          if ([400, 409, 422].includes(response.status)) {
            await rename(directory, `${directory}${RECORDING_REJECTED}`)
            notifyRecording(t("recording.rejectedTitle"), t("recording.rejectedBody", { title: meta.title }))
          }
        } catch (error) {
          host.log(`[recording] entrega de ${name} pendiente: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })().finally(() => { submittingRecordings = null })
    return submittingRecordings
  }

  function storedRecordingEvent({ key: _key, ...event }: UpcomingEvent): Omit<UpcomingEvent, "key"> { return event }

  function manualRecordingTitle(date = new Date()): string {
    return t("recording.manualTitle", { date: new Intl.DateTimeFormat(activeLanguage(), { dateStyle: "medium", timeStyle: "short" }).format(date) })
  }

  const timers: NodeJS.Timeout[] = []
  return {
    get active() { return recording.active },
    get trayState() {
      if (!RECORDING_SUPPORTED || !recordingOffers.enabled) return null
      return { title: recording.active ? recording.state.title : null, busy: recording.state.phase === "starting" || recording.state.phase === "stopping" }
    },
    async stopForQuit() {
      for (const timer of timers.splice(0)) clearInterval(timer)
      await recording.stop().catch(() => null)
    },
    onWake(pollOffers: boolean) {
      calendarEndReminder.sync()
      if (pollOffers) void pollRecordingOffers()
    },
    registerIpc() {
      ipcMain.handle(IPC.recordingEnabled, (_event, enabled: unknown) => setRecordingEnabled(enabled))
      ipcMain.handle(IPC.recordingStatus, async () => { await refreshRecordingEnabled(); return recordingStatus() })
      ipcMain.handle(IPC.recordingStart, async (_event, key: unknown) => { await startOfferedRecording(String(key)); return recordingStatus() })
      ipcMain.handle(IPC.recordingCalendar, (_event, id: unknown, key: unknown) => { chooseRecordingCalendar(id, key); return recordingStatus() })
      ipcMain.handle(IPC.recordingStop, async () => { await stopRecording(); return recordingStatus() })
      ipcMain.handle(IPC.recordingDismiss, (_event, key: unknown) => { recordingOffers.dismiss(String(key)); broadcastRecording(); return recordingStatus() })
    },
    handleTrayAction(action: TrayAction) {
      if (action === 'recording-start') void startManualRecording()
      else if (action === 'recording-window' && recordingOffers.enabled) void recording.selectSpeakerWindow().catch(() => notifyRecording(t("tray.recordWindow"), t("recording.noWindow")))
      else if (action === 'recording-tab' && recordingOffers.enabled) void recording.selectSpeakerWindow("tab").catch(() => notifyRecording(t("tray.recordTab"), t("recording.tabFallback")))
      else if (action === 'recording-stop') void stopRecording()
    },
    start() {
      if (!RECORDING_SUPPORTED || timers.length) return
      void refreshRecordingEnabled()
      void submitRecordings()
      timers.push(
        setInterval(() => void pollRecordingOffers(), RECORDING_OFFERS_POLL_MS).unref(),
        setInterval(recordingTick, RECORDING_TICK_MS).unref(),
        setInterval(() => void submitRecordings(), RECORDING_SUBMIT_RETRY_MS).unref(),
      )
      void pollRecordingOffers()
    },
  }
}
