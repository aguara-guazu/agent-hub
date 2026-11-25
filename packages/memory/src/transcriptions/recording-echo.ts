import { open, stat, type FileHandle } from "node:fs/promises"

const RATE = 16000, WINDOW = 3 * RATE, SEARCH = RATE / 2, STEP = 8

async function read(file: FileHandle, start: number, count: number): Promise<Float32Array> {
  const audio = new Float32Array(count)
  const { bytesRead } = await file.read(Buffer.from(audio.buffer), 0, audio.byteLength, start * 4)
  return audio.subarray(0, Math.floor(bytesRead / 4))
}

/** Acoustic evidence of playback in the mic, including gain, polarity and a variable capture delay.
 * This only controls attribution. It never gates, subtracts or discards microphone audio: double talk is preserved.
 */
export async function microphoneHasPlayback(mic: string, system: string, signal: AbortSignal): Promise<boolean> {
  const total = Math.min((await stat(mic)).size, (await stat(system)).size) / 4
  const a = await open(mic, "r")
  try {
    const b = await open(system, "r")
    try {
      let matches = 0
      for (let position = SEARCH; position + WINDOW + SEARCH < total; position += WINDOW) {
        signal.throwIfAborted()
        const x = await read(a, position, WINDOW), y = await read(b, position - SEARCH, WINDOW + 2 * SEARCH)
        let xx = 0
        for (let i = 0; i < x.length; i += STEP) xx += x[i]! * x[i]!
        if (xx < x.length / STEP * 1e-8) continue
        let best = 0
        for (let lag = 0; lag <= 2 * SEARCH; lag += STEP) {
          let xy = 0, yy = 0
          for (let i = 0; i < x.length; i += STEP) { const v = y[i + lag]!; xy += x[i]! * v; yy += v * v }
          if (yy > x.length / STEP * 1e-8) best = Math.max(best, Math.abs(xy) / Math.sqrt(xx * yy))
        }
        // Multiple independent windows distinguish real leakage from a coincidental transient.
        if (best > 0.25 && ++matches >= 3) return true
      }
      return false
    } finally { await b.close() }
  } finally { await a.close() }
}
