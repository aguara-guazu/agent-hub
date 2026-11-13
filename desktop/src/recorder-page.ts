import type { RecorderBridge, RecorderLevels } from "./recorder-ipc.js"
import type { RecordingTrack } from "./recording.js"

/**
 * Página de la ventana oculta de captura. Abre el micrófono y el audio del sistema como dos flujos
 * independientes y graba cada uno con su propio `MediaRecorder`, de modo que las voces remotas nunca se
 * mezclan con la de quien graba. El procesado de voz del navegador queda apagado: la diarización necesita
 * la señal sin cancelación de eco ni ganancia automática.
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
  pending: Promise<void>[]
}

const bridge = window.recorderBridge
const open: OpenTrack[] = []
let context: AudioContext | null = null
let meter: ReturnType<typeof setInterval> | null = null

function capture(name: RecordingTrack): Promise<MediaStream> {
  if (name === "mic") return navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO })
  return navigator.mediaDevices.getDisplayMedia({ audio: RAW_AUDIO, video: false })
}

async function openTrack(name: RecordingTrack, audio: AudioContext): Promise<void> {
  try {
    const source = await capture(name)
    source.getVideoTracks().forEach(track => track.stop())
    const stream = new MediaStream(source.getAudioTracks())
    if (!stream.getAudioTracks().length) throw new Error("no audio track")
    const analyser = audio.createAnalyser()
    analyser.fftSize = 2048
    audio.createMediaStreamSource(stream).connect(analyser)
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: BITS_PER_SECOND })
    const pending: Promise<void>[] = []
    recorder.ondataavailable = event => {
      if (event.data.size) pending.push(event.data.arrayBuffer().then(buffer => bridge.chunk(name, buffer)))
      if (pending.length > 8) pending.splice(0, pending.length - 8)
    }
    recorder.onerror = () => bridge.trackFailed(name, "recorder error")
    stream.getAudioTracks()[0]?.addEventListener("ended", () => bridge.trackFailed(name, "device ended"))
    recorder.start(CHUNK_MS)
    bridge.trackStarted(name, Date.now())
    open.push({ name, stream, recorder, analyser, peak: 0, pending })
  } catch (error) {
    bridge.trackFailed(name, error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  }
}

function sample(): void {
  const buffer = new Float32Array(2048)
  for (const track of open) {
    track.analyser.getFloatTimeDomainData(buffer)
    let sum = 0
    for (const value of buffer) sum += value * value
    track.peak = Math.max(track.peak, Math.sqrt(sum / buffer.length))
  }
}

async function start(): Promise<void> {
  if (context) return
  context = new AudioContext()
  await context.resume()
  await Promise.all((["mic", "system"] as const).map(name => openTrack(name, context!)))
  let ticks = 0
  meter = setInterval(() => {
    sample()
    if (++ticks % (LEVELS_MS / 100) !== 0) return
    const levels: RecorderLevels = {}
    for (const track of open) { levels[track.name] = track.peak; track.peak = 0 }
    bridge.levels(levels)
  }, 100)
}

function flush(track: OpenTrack): Promise<void> {
  return new Promise(resolve => {
    if (track.recorder.state === "inactive") return resolve()
    // `dataavailable` llega antes que `stop`, pero su `arrayBuffer()` es asíncrono: se espera la entrega del último tramo.
    track.recorder.onstop = () => { void Promise.all(track.pending).then(() => resolve()) }
    track.recorder.stop()
  })
}

async function stop(): Promise<void> {
  if (meter) clearInterval(meter)
  meter = null
  await Promise.all(open.map(flush))
  for (const track of open) track.stream.getTracks().forEach(item => item.stop())
  open.length = 0
  await context?.close().catch(() => undefined)
  context = null
  bridge.stopped()
}

bridge.onCommand(command => { void (command === "start" ? start() : stop()) })
bridge.ready()
