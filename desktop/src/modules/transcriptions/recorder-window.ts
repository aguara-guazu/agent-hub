import { BrowserWindow, desktopCapturer, Menu, session, shell, type DesktopCapturerSource, type WebFrameMain } from "electron"
import { dirname, join } from "node:path"
import { openSpeakerTab } from "./speaker-tab-server.js"
import type { openSpeakerOCR } from "@agenthub/memory/speaker-window"
import { openLinuxMonitor } from "../../linux-monitor.js"
import { captureX11Window, needsStillCapture, x11WindowTitles } from "./linux-speaker-window.js"
import { t } from "../../i18n.js"
import { secureWebPreferences } from "../../window.js"
import { RECORDER_IPC, type RecorderCommand, type RecorderLevels } from "./recorder-ipc.js"
import { RECORDING_TRACKS, type RecorderHandle, type RecordingTrack } from "./recording.js"

/**
 * Ventana oculta que captura el audio de una reunión.
 *
 * Vive en la sesión `recorder`, separada de la consola: los permisos de micrófono y de audio del sistema
 * se conceden sólo ahí, y un reinicio del core (que recarga la ventana principal) no corta la grabación.
 * El audio del sistema se pide con `getDisplayMedia` sin video; el manejador responde con el loopback, que
 * en macOS 14.2+ usa CoreAudio Tap y no requiere el permiso de grabación de pantalla.
 */

const RECORDER_PARTITION = "recorder"
const READY_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 8_000

export interface RecorderWindowPaths {
  preload: string
  page: string
}

export interface RecorderEvents {
  onTrackStarted(track: RecordingTrack, epochMs: number): void
  onTrackFailed(track: RecordingTrack, message: string): void
  onChunk(track: RecordingTrack, data: Uint8Array): void
  speakerModelDirectory?: string
  onSpeaker?(at: number, name: string): void
  onVisualError?(): void
  onVisualOpportunity?(): void
  onLevels(levels: RecorderLevels): void
}

const selectedWindow = new WeakMap<WebFrameMain, DesktopCapturerSource>()
let sessionReady = false

function prepareSession(): void {
  if (sessionReady) return
  sessionReady = true
  const recorder = session.fromPartition(RECORDER_PARTITION)
  recorder.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "media"))
  recorder.setPermissionCheckHandler((_contents, permission) => permission === "media")
  recorder.setDisplayMediaRequestHandler((request, callback) => {
    if (request.videoRequested) {
      const source = request.frame && selectedWindow.get(request.frame)
      if (!source || request.audioRequested) return callback({})
      selectedWindow.delete(request.frame!)
      return callback({ video: source })
    }
    if (!request.audioRequested) return callback({})
    callback({ audio: "loopback" })
  })
}

const isTrack = (value: unknown): value is RecordingTrack => RECORDING_TRACKS.includes(value as RecordingTrack)

export function openRecorderWindow(paths: RecorderWindowPaths, events: RecorderEvents): Promise<RecorderHandle> {
  prepareSession()
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    skipTaskbar: true,
    webPreferences: { ...secureWebPreferences(paths.preload), partition: RECORDER_PARTITION, backgroundThrottling: false },
  })
  const contents = win.webContents
  contents.on("will-navigate", event => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: "deny" }))
  contents.ipc.on(RECORDER_IPC.trackStarted, (_event, track: unknown, epochMs: unknown) => {
    if (isTrack(track) && typeof epochMs === "number") events.onTrackStarted(track, epochMs)
  })
  contents.ipc.on(RECORDER_IPC.trackFailed, (_event, track: unknown, message: unknown) => {
    if (isTrack(track)) events.onTrackFailed(track, String(message))
  })
  contents.ipc.on(RECORDER_IPC.chunk, (_event, track: unknown, data: unknown) => {
    if (isTrack(track) && data instanceof ArrayBuffer) events.onChunk(track, new Uint8Array(data))
    else if (isTrack(track) && ArrayBuffer.isView(data)) events.onChunk(track, new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  })
  contents.ipc.on(RECORDER_IPC.levels, (_event, levels: unknown) => {
    if (!levels || typeof levels !== "object") return
    const sample = levels as RecorderLevels
    events.onLevels(sample)
    if (!visualOffered && !selected && (sample.system ?? 0) > 0.003 && !abort.signal.aborted) {
      visualOffered = true
      events.onVisualOpportunity?.()
    }
  })


  const abort = new AbortController()
  let visualOffered = false
  let monitor: (() => void) | undefined
  let ocr: ReturnType<typeof openSpeakerOCR> | undefined
  let selected = false, visualFailed = false, reading = false, selection = 0
  let tab: Awaited<ReturnType<typeof openSpeakerTab>> | undefined
  const stillCapture = needsStillCapture()
  let stillId: string | undefined
  let takingStill = false
  const visualError = () => {
    if (!abort.signal.aborted && !visualFailed) events.onVisualError?.()
    visualFailed = true
  }
  contents.ipc.on(RECORDER_IPC.startMonitor, () => {
    if (process.platform !== "linux" || monitor) return
    const deliver = (bytes: Uint8Array | null) => { if (!contents.isDestroyed()) contents.send(RECORDER_IPC.monitor, bytes) }
    monitor = openLinuxMonitor(deliver, () => deliver(null))
  })
  contents.ipc.on(RECORDER_IPC.stopMonitor, () => { monitor?.(); monitor = undefined })
  contents.ipc.handle(RECORDER_IPC.speakerStill, async () => {
    if (!stillId || !selected || abort.signal.aborted || takingStill) return null
    const current = selection
    takingStill = true
    try {
      const data = await captureX11Window(stillId, abort.signal)
      return current === selection && selected ? data : null
    } catch { return null } finally { takingStill = false }
  })
  const readFrame = async (at: number, tile: boolean, image: ArrayBuffer, connected = () => true) => {
    if (!selected || abort.signal.aborted || visualFailed || !events.speakerModelDirectory) return false
    if (reading) return true
    if (!(image instanceof ArrayBuffer) || image.byteLength > 3000000 || typeof tile !== "boolean" || !Number.isFinite(at) || Math.abs(Date.now() - at) > 15000) return false
    reading = true
    const sourceSelection = selection
    try {
      ocr ??= import("@agenthub/memory/speaker-window").then(m => m.openSpeakerOCR(events.speakerModelDirectory!, abort.signal))
        .catch(error => { ocr = undefined; throw error })
      const reader = await ocr
      if (abort.signal.aborted || sourceSelection !== selection || !connected()) return false
      const name = await reader.read(Buffer.from(image), tile)
      if (name && selected && sourceSelection === selection && !abort.signal.aborted && connected()) events.onSpeaker?.(at, name)
      return true
    } catch { if (sourceSelection === selection) visualError(); return false } finally { reading = false }
  }
  contents.ipc.handle(RECORDER_IPC.speakerFrame, (_event, at, tile, image) => !tab && readFrame(at, tile, image))
  contents.ipc.on(RECORDER_IPC.tabLevel, (_event, level) => { if (Number.isFinite(level)) tab?.sample(level) })
  contents.ipc.on(RECORDER_IPC.visualFailed, visualError)
  contents.ipc.on(RECORDER_IPC.regionDone, () => { if (!win.isDestroyed()) win.hide() })
  win.on("close", event => {
    if (win.isVisible() && !abort.signal.aborted) {
      event.preventDefault(); win.hide(); selected = false; selection++; selectedWindow.delete(contents.mainFrame); contents.send(RECORDER_IPC.command, "stop-window")
    }
  })
  const resetSource = () => {
    selection++; selected = false; stillId = undefined
    tab?.close(); tab = undefined
    if (!contents.isDestroyed()) {
      selectedWindow.delete(contents.mainFrame)
      contents.send(RECORDER_IPC.command, "stop-window")
      if (win.isVisible()) win.hide()
    }
  }
  const selectSpeakerWindow = async (sourceKind: "window" | "tab" = "window") => {
    if (sourceKind === "tab") {
      resetSource()
      const current = selection
      const session = await openSpeakerTab(join(dirname(paths.page), "speaker-tab.js"), (at, tile, image, connected) =>
        current === selection ? readFrame(at, tile, image, connected) : Promise.resolve(false))
      if (current !== selection || abort.signal.aborted) { session.close(); return }
      tab = session; selected = true; visualFailed = false
      contents.send(RECORDER_IPC.command, "start-tab")
      try { await shell.openExternal(session.url) }
      catch (error) { if (current === selection) resetSource(); throw error }
      return
    }
    const hubWindows = new Set(BrowserWindow.getAllWindows().map(window => window.getMediaSourceId()))
    const windows = (await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } }))
      .filter(source => source.id.startsWith("window:") && !hubWindows.has(source.id))
    const titles = await x11WindowTitles(windows.map(source => source.id), abort.signal)
    const title = (source: DesktopCapturerSource) => titles.get(source.id) ?? source.name
    const sources = windows.filter(source => !/meet\.google\.com|google meet|^meet\s*[-–]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(title(source)))
    if (abort.signal.aborted) return
    if (!sources.length) { events.onVisualError?.(); return }
    const choose = (source: DesktopCapturerSource, region: boolean) => {
      if (abort.signal.aborted) return
      resetSource(); selected = true; visualFailed = false
      if (stillCapture) stillId = source.id
      else selectedWindow.set(contents.mainFrame, source)
      if (region) { win.setSize(860, 580); win.center(); win.show() }
      const detail = JSON.stringify({ instruction: region ? t("recording.markHint") : undefined, still: stillCapture })
      void contents.executeJavaScript(`window.dispatchEvent(new CustomEvent("recorder-speaker-window",{detail:${detail}}))`, true).catch(visualError)
    }
    Menu.buildFromTemplate([
      { label: t("tray.recordWindow"), enabled: false },
      ...sources.map(source => ({ label: title(source) || source.id, submenu: [
        { label: t("recording.autoSpeaker"), click: () => choose(source, false) },
        { label: t("recording.markSpeaker"), click: () => choose(source, true) },
      ] })),
      { label: t("recording.noVisual"), click: resetSource },
    ]).popup()
  }

  const send = (command: RecorderCommand): void => { if (!win.isDestroyed()) contents.send(RECORDER_IPC.command, command) }
  const handle: RecorderHandle = {
    selectSpeakerWindow,
    start: () => send("start"),
    stop: () => new Promise<void>((resolve, reject) => {
      resetSource()
      if (win.isDestroyed()) return resolve()
      const timer = setTimeout(() => reject(new Error("timeout")), STOP_TIMEOUT_MS)
      contents.ipc.once(RECORDER_IPC.stopped, () => { clearTimeout(timer); resolve() })
      send("stop")
    }),
    close: () => {
      abort.abort(); tab?.close(); monitor?.()
      void ocr?.then(reader => reader.close()).catch(() => {})
      if (!win.isDestroyed()) win.destroy()
    },
  }

  return new Promise<RecorderHandle>((resolve, reject) => {
    const fail = (reason: string): void => { clearTimeout(timer); handle.close(); reject(new Error(reason)) }
    const timer = setTimeout(() => fail("la ventana de captura no respondió"), READY_TIMEOUT_MS)
    contents.ipc.once(RECORDER_IPC.ready, () => { clearTimeout(timer); resolve(handle) })
    contents.once("did-fail-load", (_event, _code, description) => fail(`no cargó la página de captura: ${description}`))
    contents.once("render-process-gone", (_event, details) => { for (const track of RECORDING_TRACKS) events.onTrackFailed(track, `render process gone: ${details.reason}`) })
    void win.loadFile(paths.page)
  })
}
