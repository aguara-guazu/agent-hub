import { runAudioAnalysis } from "./audio-analysis-child.js"
import type { MediaAssets } from "./transcriptions/media-assets.js"

export interface SpeechRegion { start: number; end: number }

export async function detectSpeech(assets: MediaAssets, pcm: string, signal: AbortSignal): Promise<SpeechRegion[]> {
  const model = await assets.verified("silero_vad.onnx")
  return runAudioAnalysis(new URL("./speech-detection-worker.js", import.meta.url), { pcm, model }, "Detección de habla", 10 * 60_000, signal)
}

/** Keep context across short pauses; isolated syllables make Whisper repeat or invent text. */
export function speechWindows(regions: SpeechRegion[], duration: number): SpeechRegion[] {
  const windows: SpeechRegion[] = []
  for (const speech of regions) {
    let start = Math.max(0, speech.start - 0.15)
    const end = Math.min(duration, speech.end + 0.15)
    const last = windows.at(-1)
    if (last && start - last.end <= 3 && end - last.start <= 30) { last.end = Math.max(last.end, end); continue }
    if (last) start = Math.max(start, last.end)
    while (end > start) { const to = Math.min(end, start + 30); windows.push({ start, end: to }); start = to }
  }
  return windows
}
