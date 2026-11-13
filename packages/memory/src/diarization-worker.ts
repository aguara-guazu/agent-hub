import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { parentPort, workerData } from "node:worker_threads"

/**
 * Speaker diarization and voiceprints over a 16 kHz mono float32 PCM file.
 *
 * Runs in its own thread: sherpa-onnx brings its own ONNX runtime and holds the whole track in memory while it
 * clusters. Every native call that returns audio or vectors passes `enableExternalBuffer=false`; Electron's V8
 * sandbox aborts on external ArrayBuffers.
 */

export interface DiarizationTask {
  pcm: string
  segmentation: string
  embedding: string
  threshold: number
  /** Present for a voiceprint-only run: seconds of the track that belong to one known speaker. */
  intervals?: [number, number][]
}
export interface VoiceTurn { start: number; end: number; voice: number }
export interface Voiceprint { voice: number; seconds: number; embedding: number[] }
export interface DiarizationResult { turns: VoiceTurn[]; voices: Voiceprint[] }

const SAMPLE_RATE = 16000
/** Audio per voice fed to the embedding model; more adds time without changing the vector much. */
const VOICEPRINT_SECONDS = 90
const MIN_VOICEPRINT_SECONDS = 2
/** Clusters whose voiceprints are at least this similar are one person split in two; distinct voices measured below 0.8. */
const SAME_VOICE_SIMILARITY = 0.85

const task = workerData as DiarizationTask

function excerpt(audio: Float32Array, spans: [number, number][]): Float32Array {
  const longest = [...spans].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))
  const parts: Float32Array[] = []
  let total = 0
  for (const [start, end] of longest) {
    if (total >= VOICEPRINT_SECONDS * SAMPLE_RATE) break
    const part = audio.subarray(Math.max(0, Math.floor(start * SAMPLE_RATE)), Math.min(audio.length, Math.ceil(end * SAMPLE_RATE)))
    parts.push(part)
    total += part.length
  }
  const joined = new Float32Array(total)
  let offset = 0
  for (const part of parts) { joined.set(part, offset); offset += part.length }
  return joined
}

function normalized(vector: Float32Array): number[] {
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm) || 1
  return Array.from(vector, value => value / norm)
}

try {
  // CommonJS addon: a dynamic import() does not expose its classes as named exports.
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as typeof import("sherpa-onnx-node")
  const bytes = await readFile(task.pcm)
  const audio = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: task.embedding, numThreads: 2 })
  const embed = (voice: number, spans: [number, number][]): Voiceprint | null => {
    const samples = excerpt(audio, spans)
    if (samples.length < MIN_VOICEPRINT_SECONDS * SAMPLE_RATE) return null
    const stream = extractor.createStream()
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
    stream.inputFinished()
    if (!extractor.isReady(stream)) return null
    return { voice, seconds: samples.length / SAMPLE_RATE, embedding: normalized(extractor.compute(stream, false)) }
  }
  let result: DiarizationResult
  if (task.intervals) {
    const own = embed(0, task.intervals)
    result = { turns: [], voices: own ? [own] : [] }
  } else {
    const diarizer = new sherpa.OfflineSpeakerDiarization({
      segmentation: { pyannote: { model: task.segmentation }, numThreads: 2 },
      embedding: { model: task.embedding, numThreads: 2 },
      clustering: { numClusters: -1, threshold: task.threshold },
      minDurationOn: 0.3,
      minDurationOff: 0.5,
    })
    const segments = audio.length >= SAMPLE_RATE ? diarizer.process(audio) : []
    // Cluster ids are arbitrary; voices are renumbered from 1 in order of first appearance.
    const order = new Map<number, number>()
    const turns: VoiceTurn[] = [...segments].sort((a, b) => a.start - b.start).map(segment => {
      if (!order.has(segment.speaker)) order.set(segment.speaker, order.size + 1)
      return { start: segment.start, end: segment.end, voice: order.get(segment.speaker)! }
    })
    const spans = (voice: number): [number, number][] => turns.filter(turn => turn.voice === voice).map(turn => [turn.start, turn.end])
    const prints = new Map<number, Voiceprint>()
    for (const voice of order.values()) { const print = embed(voice, spans(voice)); if (print) prints.set(voice, print) }
    const similarity = (a: Voiceprint, b: Voiceprint): number => a.embedding.reduce((sum, value, index) => sum + value * b.embedding[index]!, 0)
    for (;;) {
      let pair: [Voiceprint, Voiceprint] | null = null, best = SAME_VOICE_SIMILARITY
      for (const a of prints.values()) for (const b of prints.values()) if (a.voice < b.voice && similarity(a, b) >= best) { best = similarity(a, b); pair = [a, b] }
      if (!pair) break
      const [kept, absorbed] = pair[0].seconds >= pair[1].seconds ? pair : [pair[1], pair[0]]
      for (const turn of turns) if (turn.voice === absorbed.voice) turn.voice = kept.voice
      prints.delete(absorbed.voice)
      const merged = embed(kept.voice, spans(kept.voice))
      if (merged) prints.set(kept.voice, merged)
    }
    // Merging leaves gaps in the numbering: voices are renumbered once more by first appearance.
    const final = new Map<number, number>()
    for (const turn of turns) { if (!final.has(turn.voice)) final.set(turn.voice, final.size + 1); turn.voice = final.get(turn.voice)! }
    result = { turns, voices: [...prints.values()].map(print => ({ ...print, voice: final.get(print.voice)! })).sort((a, b) => a.voice - b.voice) }
  }
  parentPort!.postMessage({ type: "result", result })
} catch (error) {
  parentPort!.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) })
}
