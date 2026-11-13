import { Worker } from "node:worker_threads"
import { MemoryError } from "./contracts.js"
import type { MediaAssets } from "./media-assets.js"
import type { DiarizationResult, DiarizationTask } from "./diarization-worker.js"

export type { DiarizationResult, VoiceTurn, Voiceprint } from "./diarization-worker.js"

/** Agglomerative clustering cut-off on cosine distance. Higher values merge distinct voices; measured on Spanish speech with TitaNet small. */
export const DIARIZATION_THRESHOLD = 0.5
const DIARIZATION_TIMEOUT_MS = 30 * 60_000

function run(task: DiarizationTask, signal: AbortSignal): Promise<DiarizationResult> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./diarization-worker.js", import.meta.url), { workerData: task })
    const finish = (settle: () => void): void => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      worker.removeAllListeners()
      void worker.terminate()
      settle()
    }
    const abort = (): void => finish(() => reject(new MemoryError(499, "Separación de voces cancelada")))
    const timer = setTimeout(() => finish(() => reject(new MemoryError(422, "La separación de voces no respondió a tiempo"))), DIARIZATION_TIMEOUT_MS)
    signal.addEventListener("abort", abort, { once: true })
    worker.on("message", message => {
      if (message.type === "result") finish(() => resolve(message.result as DiarizationResult))
      else finish(() => reject(new MemoryError(422, `No se pudieron separar las voces: ${message.error}`)))
    })
    worker.on("error", error => finish(() => reject(new MemoryError(422, `No se pudieron separar las voces: ${error.message}`))))
    worker.on("exit", code => finish(() => reject(new MemoryError(422, `La separación de voces se cerró (${code})`))))
  })
}

async function models(assets: MediaAssets): Promise<Pick<DiarizationTask, "segmentation" | "embedding">> {
  return { segmentation: await assets.verified("segmentation.onnx"), embedding: await assets.verified("embedding.onnx") }
}

/** Speaker turns of a PCM track with one voiceprint per detected voice. */
export async function diarize(assets: MediaAssets, pcm: string, signal: AbortSignal): Promise<DiarizationResult> {
  return run({ pcm, ...await models(assets), threshold: DIARIZATION_THRESHOLD }, signal)
}

/** Voiceprint of a single known speaker from the given spans (seconds) of a PCM track; `null` when there is too little speech. */
export async function voiceprint(assets: MediaAssets, pcm: string, intervals: [number, number][], signal: AbortSignal): Promise<number[] | null> {
  if (!intervals.length) return null
  const result = await run({ pcm, ...await models(assets), threshold: DIARIZATION_THRESHOLD, intervals }, signal)
  return result.voices[0]?.embedding ?? null
}
