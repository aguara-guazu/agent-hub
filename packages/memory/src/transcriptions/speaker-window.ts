// OCR runs on the device. Return only a speaker label, never other window text.
import { createWorker, OEM, PSM } from "tesseract.js"
import { MediaAssets } from "./media-assets.js"

export function speakerLabel(text: string, tile: boolean): string | null {
  const names = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    const marked = /^(?:speaking|active speaker|hablando|orador activo)\s*[:：]\s*(.+)$/iu.exec(value)?.[1]
      ?? /^(.+?)\s+(?:is speaking|está hablando)[.!]?$/iu.exec(value)?.[1]
    const name = (marked ?? (tile ? value : "")).trim()
    if (/^[\p{L}][\p{L}\p{M} .'’-]{1,79}$/u.test(name) && name.split(/\s+/).length <= 6 &&
        !/^(?:you|tú|vos|me|unknown|anonymous|speaker|anónimo|participante|chat|mute|participants|speaking|compartir|silenciar)\b/iu.test(name)) names.add(name)
  }
  return names.size === 1 ? [...names][0]! : null
}

export async function openSpeakerOCR(directory: string, signal: AbortSignal) {
  const assets = new MediaAssets(directory, "ocr")
  try {
    if (!assets.installed()) {
      assets.install()
      while (assets.status().state === "downloading") {
        signal.throwIfAborted()
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
    for (const file of assets.files) await assets.verified(file.name)
    signal.throwIfAborted()
    const worker = await createWorker(["eng", "spa"], OEM.LSTM_ONLY, { langPath: assets.directory, cacheMethod: "none", errorHandler: () => {} })
    return {
      close: () => worker.terminate(),
      async read(image: Buffer, tile: boolean) {
        await worker.setParameters({ tessedit_pageseg_mode: tile ? PSM.SINGLE_LINE : PSM.SPARSE_TEXT })
        const result = await worker.recognize(image, {}, { blocks: true })
        const lines = (result.data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines.filter(l => l.confidence >= 75).map(l => l.text)))
        return speakerLabel(lines.join("\n"), tile)
      },
    }
  } finally { await assets.close() }
}
