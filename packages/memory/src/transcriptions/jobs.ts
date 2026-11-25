import type { MemoryStore } from '../store.js'
import type { MemoryAI } from '../ai.js'
import type { AIConfig } from '../config.js'
import { MemoryError } from '../contracts.js'
import type { MediaRuntime } from './media-runtime.js'
import { processMedia, queueMedia } from './media-processing.js'
import { linkRecordingEvents, processRecording } from './recording-processing.js'
import { sweepRecordings } from './recordings.js'

export async function scheduleTranscriptions(store: MemoryStore, media?: MediaRuntime) {
  if (media) await queueMedia(store, {}, true, media)
  await sweepRecordings(store)
  await linkRecordingEvents(store)
}

export async function runTranscriptionJob(
  store: MemoryStore, media: MediaRuntime | undefined, ai: MemoryAI, settings: () => Promise<AIConfig>,
  job: Record<string, any>, signal: AbortSignal, progress: (value: Record<string, unknown>) => Promise<void>,
) {
  if (!media) throw new MemoryError(409, 'El procesamiento multimedia no está disponible')
  if (job.kind === 'media') {
    await progress(await processMedia(store, media, job.payload, signal, progress))
  } else {
    const config = await settings()
    await progress(await processRecording(store, media, job.payload, signal, progress, { ai: ai.forJob(config, signal, progress), config }))
  }
}
