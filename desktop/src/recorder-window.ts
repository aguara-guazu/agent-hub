import { BrowserWindow, session } from "electron"
import { secureWebPreferences } from "./window.js"
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
  onLevels(levels: RecorderLevels): void
}

let sessionReady = false

function prepareSession(): void {
  if (sessionReady) return
  sessionReady = true
  const recorder = session.fromPartition(RECORDER_PARTITION)
  recorder.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "media"))
  recorder.setPermissionCheckHandler((_contents, permission) => permission === "media")
  recorder.setDisplayMediaRequestHandler((request, callback) => {
    if (request.videoRequested || !request.audioRequested) return callback({})
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
    if (levels && typeof levels === "object") events.onLevels(levels as RecorderLevels)
  })

  const send = (command: RecorderCommand): void => { if (!win.isDestroyed()) contents.send(RECORDER_IPC.command, command) }
  const handle: RecorderHandle = {
    start: () => send("start"),
    stop: () => new Promise<void>((resolve, reject) => {
      if (win.isDestroyed()) return resolve()
      const timer = setTimeout(() => reject(new Error("timeout")), STOP_TIMEOUT_MS)
      contents.ipc.once(RECORDER_IPC.stopped, () => { clearTimeout(timer); resolve() })
      send("stop")
    }),
    close: () => { if (!win.isDestroyed()) win.destroy() },
  }

  return new Promise<RecorderHandle>((resolve, reject) => {
    const fail = (reason: string): void => { clearTimeout(timer); handle.close(); reject(new Error(reason)) }
    const timer = setTimeout(() => fail("la ventana de captura no respondió"), READY_TIMEOUT_MS)
    contents.ipc.once(RECORDER_IPC.ready, () => { clearTimeout(timer); resolve(handle) })
    contents.once("did-fail-load", (_event, _code, description) => fail(`no cargó la página de captura: ${description}`))
    contents.once("render-process-gone", (_event, details) => events.onTrackFailed("mic", `render process gone: ${details.reason}`))
    void win.loadFile(paths.page)
  })
}
