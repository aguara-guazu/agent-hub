import { open } from "node:fs/promises"
import { createRequire } from "node:module"

/** Stream PCM through VAD without holding a three-hour recording in memory. */
async function detect({ pcm, model }: { pcm: string; model: string }) {
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as typeof import("sherpa-onnx-node")
  const vad = new sherpa.Vad({ sileroVad: { model, threshold: 0.5, minSilenceDuration: 0.3,
    minSpeechDuration: 0.25, maxSpeechDuration: 25, windowSize: 512 }, sampleRate: 16000, numThreads: 1 }, 60)
  const regions: { start: number; end: number }[] = []
  const drain = () => {
    while (!vad.isEmpty()) {
      // Electron aborts the process if native code creates an external ArrayBuffer.
      const speech = vad.front(false)
      regions.push({ start: speech.start / 16000, end: (speech.start + speech.samples.length) / 16000 })
      vad.pop()
    }
  }
  const file = await open(pcm, "r")
  try {
    const samples = new Float32Array(512), buffer = Buffer.from(samples.buffer)
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      vad.acceptWaveform(samples.subarray(0, Math.floor(bytesRead / 4)))
      drain()
    }
    vad.flush(); drain()
  } finally { await file.close() }
  return regions
}

process.once("message", (task: { pcm: string; model: string }) => {
  void detect(task).then(result => process.send!({ result }), error => process.send!({ error: error instanceof Error ? error.message : String(error) }))
})
