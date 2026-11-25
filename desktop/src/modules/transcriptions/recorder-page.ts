import { SpeakerView } from "./speaker-view.js"
import { monitorStream } from "../../monitor-stream.js"
import type { RecorderBridge, RecorderLevels } from "./recorder-ipc.js"
import type { RecordingTrack } from "./recording.js"

/**
 * Página de la ventana oculta de captura. Abre el micrófono y el audio del sistema como dos flujos
 * independientes y graba cada uno con su propio `MediaRecorder`. Con parlantes puede haber fuga acústica
 * al micrófono: el procesamiento posterior compara ambas pistas. Se conserva la señal sin ganancia automática.
 */

declare global {
  interface Window { recorderBridge: RecorderBridge }
}

const CHUNK_MS = 5_000
const LEVELS_MS = 2_000
const BITS_PER_SECOND = 32_000
const RAW_AUDIO: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }

interface OpenTrack {
  name: RecordingTrack
  stream: MediaStream
  recorder: MediaRecorder
  analyser: AnalyserNode
  peak: number
  pending: Promise<void>
  stopped: Promise<void>
}

const bridge = window.recorderBridge
const speakerView = new SpeakerView(bridge)
let webTab = false
const open: OpenTrack[] = []
let context: AudioContext | null = null
let meter: ReturnType<typeof setInterval> | null = null
let stopping: Promise<void> | null = null

async function capture(name: RecordingTrack): Promise<MediaStream> {
  if (name === "mic") return navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO })
  if (bridge.linuxMonitor && context) return monitorStream(context, bridge)
  return navigator.mediaDevices.getDisplayMedia({ audio: RAW_AUDIO, video: false })
}

async function openTrack(name: RecordingTrack, audio: AudioContext): Promise<void> {
  let source: MediaStream | undefined
  try {
    source = await capture(name)
    // Detener no espera un diálogo de permisos; una concesión tardía se libera sin grabar.
    if (context !== audio) { source.getTracks().forEach(track => track.stop()); return }
    source.getVideoTracks().forEach(track => track.stop())
    const stream = new MediaStream(source.getAudioTracks())
    if (!stream.getAudioTracks().length || stream.getAudioTracks().every(track => track.readyState === "ended")) throw new Error("no live audio track")
    const analyser = audio.createAnalyser()
    analyser.fftSize = 2048
    audio.createMediaStreamSource(stream).connect(analyser)
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: BITS_PER_SECOND })
    const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve() })
    const track: OpenTrack = { name, stream, recorder, analyser, peak: 0, pending: Promise.resolve(), stopped }
    recorder.ondataavailable = event => {
      if (!event.data.size) return
      // Mantiene el orden y todos los tramos pendientes, aun si leer un Blob tarda más que el siguiente.
      track.pending = track.pending.then(async () => bridge.chunk(name, await event.data.arrayBuffer())).catch(error => {
        bridge.trackFailed(name, `audio chunk: ${String(error)}`)
        stream.getTracks().forEach(item => item.stop())
      })
    }
    recorder.onerror = () => bridge.trackFailed(name, "recorder error")
    stream.getAudioTracks()[0]?.addEventListener("ended", () => bridge.trackFailed(name, "device ended"))
    recorder.start(CHUNK_MS)
    bridge.trackStarted(name, Date.now())
    open.push(track)
  } catch (error) {
    source?.getTracks().forEach(track => track.stop())
    if (context === audio) bridge.trackFailed(name, error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  }
}

function sample(): void {
  const buffer = new Float32Array(2048)
  for (const track of open) {
    track.analyser.getFloatTimeDomainData(buffer)
    let sum = 0
    for (const value of buffer) sum += value * value
    const level = Math.sqrt(sum / buffer.length)
    track.peak = Math.max(track.peak, level)
    if (track.name === "system") {
      if (webTab) bridge.tabLevel(level)
      else speakerView.sample(level)
    }
  }
}

async function start(): Promise<void> {
  if (context || stopping) return
  const audio = new AudioContext()
  context = audio
  try {
    await audio.resume()
    if (context !== audio) return
    for (const name of ["mic", "system"] as const) void openTrack(name, audio)
  } catch (error) {
    if (context === audio) for (const track of ["mic", "system"] as const) bridge.trackFailed(track, String(error))
    return
  }
  if (context !== audio) return
  let ticks = 0
  meter = setInterval(() => {
    sample()
    if (++ticks % (LEVELS_MS / 100) !== 0) return
    const levels: RecorderLevels = {}
    for (const track of open) { levels[track.name] = track.peak; track.peak = 0 }
    bridge.levels(levels)
  }, 100)
}

async function flush(track: OpenTrack): Promise<void> {
  if (track.recorder.state !== "inactive") track.recorder.stop()
  // `inactive` puede llegar antes que los eventos finales. La promesa se arma antes de empezar a grabar.
  await track.stopped
  await track.pending
}

function stop(): Promise<void> {
  if (stopping) return stopping
  const audio = context
  speakerView.stop()
  context = null
  if (meter) clearInterval(meter)
  meter = null
  const tracks = open.splice(0)
  stopping = (async () => {
    await Promise.all(tracks.map(flush))
    for (const track of tracks) track.stream.getTracks().forEach(item => item.stop())
    await audio?.close().catch(() => undefined)
    bridge.stopped()
  })().finally(() => { stopping = null })
  return stopping
}

window.addEventListener("recorder-speaker-window", event => {
  const options = (event as CustomEvent).detail
  if (context) void speakerView.start(options?.instruction, options?.still === true).catch(() => { speakerView.stop(); bridge.visualFailed(); bridge.regionDone() })
})
bridge.onCommand(command => {
  if (command === "stop-window" || command === "start-tab") { webTab = command === "start-tab"; speakerView.stop(); return }
  void (command === "start" ? start() : stop())
})
bridge.ready()
