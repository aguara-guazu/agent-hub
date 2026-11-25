import { runAudioAnalysis } from "./audio-analysis-child.js"
import type { MediaAssets } from "./transcriptions/media-assets.js"
import type { DiarizationResult, DiarizationTask } from "./diarization-worker.js"
import type { SpeechRegion } from "./speech-detection.js"

export type { DiarizationResult, VoiceTurn, Voiceprint } from "./diarization-worker.js"

/** Agglomerative clustering cut-off on cosine distance. Higher values merge distinct voices; measured on Spanish speech with TitaNet small. */
export const DIARIZATION_THRESHOLD = 0.5
const DIARIZATION_TIMEOUT_MS = 30 * 60_000

function run(task: DiarizationTask, signal: AbortSignal): Promise<DiarizationResult> {
  return runAudioAnalysis(new URL("./diarization-worker.js", import.meta.url), task, "Separación de voces", DIARIZATION_TIMEOUT_MS, signal)
}

async function models(assets: MediaAssets): Promise<Pick<DiarizationTask, "segmentation" | "embedding">> {
  return { segmentation: await assets.verified("segmentation.onnx"), embedding: await assets.verified("embedding.onnx") }
}

/** Speaker turns of a PCM track with one voiceprint per detected voice. */
export async function diarize(assets: MediaAssets, pcm: string, signal: AbortSignal, speech?: SpeechRegion[]): Promise<DiarizationResult> {
  return run({ pcm, ...await models(assets), threshold: DIARIZATION_THRESHOLD, speech }, signal)
}

/** Voiceprint of a single known speaker from the given spans (seconds) of a PCM track; `null` when there is too little speech. */
export async function voiceprint(assets: MediaAssets, pcm: string, intervals: [number, number][], signal: AbortSignal): Promise<number[] | null> {
  if (!intervals.length) return null
  const result = await run({ pcm, ...await models(assets), threshold: DIARIZATION_THRESHOLD, intervals }, signal)
  return result.voices[0]?.embedding ?? null
}
