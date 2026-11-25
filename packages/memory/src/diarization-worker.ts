import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { createRequire } from "node:module"
import { clusterSpeech, diarizationSegments, speechTurns } from "./diarization-clustering.js"

/**
 * Speaker diarization and voiceprints over a 16 kHz mono float32 PCM file.
 *
 * Runs in a child process with bounded PCM reads. Every native call that returns audio or vectors passes
 * `enableExternalBuffer=false`; Electron's V8
 * sandbox aborts on external ArrayBuffers.
 */

export interface DiarizationTask {
  pcm: string
  segmentation: string
  embedding: string
  threshold: number
  speech?: { start: number; end: number }[] | undefined
  /** Present for a voiceprint-only run: seconds of the track that belong to one known speaker. */
  intervals?: [number, number][]
}
export interface VoiceTurn { start: number; end: number; voice: number }
export interface Voiceprint { voice: number; seconds: number; embedding: number[] }
export interface DiarizationResult { turns: VoiceTurn[]; voices: Voiceprint[] }

const SAMPLE_RATE = 16000
/** Audio per voice fed to the embedding model; more adds time without changing the vector much. */
const VOICEPRINT_SECONDS = 90
/** Longer inputs make ONNX's memory arena request a block that aborts Electron's allocator. */
const VOICEPRINT_CHUNK_SECONDS = 10
const MIN_VOICEPRINT_SECONDS = 2
/** Clean utterance centroids, calibrated on separate public human-speaker controls. */
const SAME_VOICE_SIMILARITY = 0.55
const MIN_UTTERANCE_SECONDS = 1

function excerpt(read: (first: number, count: number) => Float32Array, length: number, spans: [number, number][]): Float32Array {
  const longest = [...spans].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))
  const parts: Float32Array[] = []
  let total = 0
  for (const [start, end] of longest) {
    if (total >= VOICEPRINT_SECONDS * SAMPLE_RATE) break
    const from = Math.max(0, Math.floor(start * SAMPLE_RATE))
    const to = Math.min(length, Math.ceil(end * SAMPLE_RATE), from + VOICEPRINT_SECONDS * SAMPLE_RATE - total)
    if (to <= from) continue
    const part = read(from, to - from)
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

function analyze(task: DiarizationTask, file: number): DiarizationResult {
  // CommonJS addon: a dynamic import() does not expose its classes as named exports.
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as typeof import("sherpa-onnx-node")
  const length = Math.floor(fstatSync(file).size / 4)
  const read = (first: number, count: number): Float32Array => {
    const samples = new Float32Array(count), buffer = Buffer.from(samples.buffer)
    let offset = 0
    while (offset < buffer.length) {
      const bytes = readSync(file, buffer, offset, buffer.length - offset, first * 4 + offset)
      if (!bytes) throw new Error("La pista PCM terminó antes de tiempo")
      offset += bytes
    }
    return samples
  }
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: task.embedding, numThreads: 2 })
  const embed = (voice: number, spans: [number, number][], minimum = MIN_VOICEPRINT_SECONDS): Voiceprint | null => {
    if (task.speech) spans = spans.flatMap(([start, end]) => task.speech!.map(speech => [Math.max(start, speech.start), Math.min(end, speech.end)] as [number, number]).filter(([from, to]) => to > from))
    const samples = excerpt(read, length, spans)
    if (samples.length < minimum * SAMPLE_RATE) return null
    // Keep the same total speech budget, but average short embeddings instead of sending minutes in one call.
    // Balanced chunks avoid a final sliver shorter than the model's minimum speech duration.
    const count = Math.ceil(samples.length / (VOICEPRINT_CHUNK_SECONDS * SAMPLE_RATE))
    const size = Math.ceil(samples.length / count)
    let combined: Float32Array | undefined
    let used = 0
    for (let start = 0; start < samples.length; start += size) {
      const chunk = samples.subarray(start, Math.min(start + size, samples.length))
      const stream = extractor.createStream()
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: chunk })
      stream.inputFinished()
      if (!extractor.isReady(stream)) continue
      const vector = normalized(extractor.compute(stream, false))
      combined ??= new Float32Array(vector.length)
      for (let index = 0; index < vector.length; index++) combined[index]! += vector[index]! * chunk.length
      used += chunk.length
    }
    return combined && used >= minimum * SAMPLE_RATE
      ? { voice, seconds: spans.reduce((sum, [start, end]) => sum + end - start, 0), embedding: normalized(combined) } : null
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
    const segments = diarizationSegments(length / SAMPLE_RATE, task.speech, (from, to) =>
      diarizer.process(read(Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE) - Math.round(from * SAMPLE_RATE))))
    // Native speaker ids are useful for local boundaries, but cannot safely define a voiceprint: a cluster
    // can already contain two people. Compute independent prints on speech between pauses first.
    const nativeSpeech: { start: number; end: number }[] = []
    for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
      const previous = nativeSpeech.at(-1)
      if (previous && previous.end >= segment.start) previous.end = Math.max(previous.end, segment.end)
      else nativeSpeech.push({ start: segment.start, end: segment.end })
    }
    const regions = task.speech ?? nativeSpeech
    const pieces = speechTurns(segments, regions)
    const prints = pieces.flatMap((piece, index) => {
      if (piece.overlap) return []
      const print = embed(index, [[piece.start, piece.end]], MIN_UTTERANCE_SECONDS)
      return print ? [{ index, seconds: print.seconds, embedding: print.embedding }] : []
    })
    const groups = clusterSpeech(prints, SAME_VOICE_SIMILARITY)
      .filter(group => group.seconds >= MIN_VOICEPRINT_SECONDS)
      .sort((a, b) => Math.min(...a.indices) - Math.min(...b.indices))
    const turns: VoiceTurn[] = pieces.map(piece => ({ start: piece.start, end: piece.end, voice: 0 }))
    const voices: Voiceprint[] = groups.map((group, index) => {
      const voice = index + 1
      for (const piece of group.indices) turns[piece]!.voice = voice
      return { voice, seconds: group.seconds, embedding: group.embedding }
    })
    result = { turns, voices }
  }
  return result
}

process.once("message", (task: DiarizationTask) => {
  let file: number | undefined
  try {
    file = openSync(task.pcm, "r")
    process.send!({ type: "result", result: analyze(task, file) })
  } catch (error) {
    process.send!({ type: "error", error: error instanceof Error ? error.message : String(error) })
  } finally {
    if (file !== undefined) closeSync(file)
  }
})
