import { pdfPages } from './pdf.js'
import { splitText } from './transcript.js'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorker, OEM } from 'tesseract.js'
import sharp from 'sharp'
import { z } from 'zod'
import { check, MemoryError, parse } from './contracts.js'
import { NativeEmbeddings } from './native-embeddings.js'
import { MediaAssets } from './media-assets.js'

export const mediaSettingsInput = z.object({ pdf: z.boolean().default(true), ocr: z.boolean().default(false), transcription: z.boolean().default(false),
  vision: z.boolean().default(false), audio: z.boolean().default(false), language: z.enum(['es','en','pt','fr','de','it','ja','zh','ko','ru','ar','hi']).default('es'), automatic: z.boolean().default(true) }).strict()
export type MediaSettings = z.infer<typeof mediaSettingsInput>
export const MEDIA_MODULES = ['ocr','decoder','vision','audio','speech'] as const
export const MEDIA_MAX_SECONDS = 1800, VIDEO_FRAME_INTERVAL = 5, MEDIA_REVISION = 'media-v1'
export type MediaPart = { text: string; offset_ms?: number | undefined; metadata: Record<string, any>; vector?: number[] }
export type MediaInput = { data: Buffer; mime_type: string; filename: string }
export class MediaRuntime {
  readonly ocr: MediaAssets
  readonly decoder: MediaAssets
  readonly vision: NativeEmbeddings
  readonly audio: NativeEmbeddings
  readonly speech: NativeEmbeddings
  constructor(directory: string) {
    this.ocr = new MediaAssets(directory, 'ocr'); this.decoder = new MediaAssets(directory, 'decoder')
    this.vision = new NativeEmbeddings(directory, 'vision'); this.audio = new NativeEmbeddings(directory, 'audio'); this.speech = new NativeEmbeddings(directory, 'speech')
  }
  status() { return Object.fromEntries(MEDIA_MODULES.map(m => [m, this[m].status()])) }
  validate(raw: unknown) {
    const settings = parse(mediaSettingsInput, raw)
    for (const name of ['ocr','vision','audio'] as const) if (settings[name]) check(this[name].installed(), `Descargá el módulo ${name} primero`, 409)
    if (settings.transcription) check(this.speech.installed(), 'Descargá el modelo de transcripción primero', 409)
    if (settings.transcription || settings.audio) check(this.decoder.installed(), 'Descargá el decodificador de audio y video primero', 409)
    return settings
  }
  async process(input: MediaInput, settings: MediaSettings, signal: AbortSignal, report: (p: Record<string, unknown>) => Promise<void>) {
    const parts: MediaPart[] = [], warnings: string[] = []
    let worker: Awaited<ReturnType<typeof createWorker>> | undefined
    const abortOCR = () => { if (worker) void worker.terminate() }
    signal.addEventListener('abort', abortOCR, { once: true })
    const ocr = async (data: Buffer, offset_ms?: number) => {
      signal.throwIfAborted()
      if (!worker) {
        check(this.ocr.installed(), 'Falta descargar OCR local', 409)
        const starting = createWorker(['eng','spa'], OEM.LSTM_ONLY, { langPath: this.ocr.directory, cacheMethod: 'none', gzip: true, errorHandler: () => {} })
        try { worker = await interruptibleOCR(starting, signal) }
        catch (error) { void starting.then(late => late.terminate()).catch(() => {}); throw error }
      }
      signal.throwIfAborted()
      const prepared = await sharp(data, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
      const imageSize = await sharp(prepared).metadata()
      const result = await interruptibleOCR(worker.recognize(prepared, {}, { text: true, blocks: true }), signal)
      for (const block of result.data.blocks ?? []) for (const paragraph of block.paragraphs) {
        const text = paragraph.text.trim()
        if (text) parts.push({ text, offset_ms, metadata: { generated: 'ocr', processor: 'tesseract-7-eng-spa-fast', confidence: paragraph.confidence / 100, bbox: paragraph.bbox,
          image_width: imageSize.width, image_height: imageSize.height,
          region: { x: paragraph.bbox.x0 / imageSize.width!, y: paragraph.bbox.y0 / imageSize.height!, width: (paragraph.bbox.x1 - paragraph.bbox.x0) / imageSize.width!, height: (paragraph.bbox.y1 - paragraph.bbox.y0) / imageSize.height! }, ...(offset_ms === undefined ? {} : { end_offset_ms: offset_ms }) } })
      }
      if (!result.data.blocks?.length && result.data.text.trim()) parts.push({ text: result.data.text.trim(), offset_ms, metadata: { generated: 'ocr', processor: 'tesseract-7-eng-spa-fast', confidence: result.data.confidence / 100 } })
    }
    let directory: string | undefined
    try {
      if (input.mime_type === 'application/pdf') {
        for await (const page of pdfPages(input.data, { vision: settings.vision, ocr: settings.ocr }, signal)) {
          await report({ stage: 'pdf', media_page: page.page, media_pages: page.count })
          for (const chunk of splitText(page.text)) parts.push({ text: chunk.text, metadata: { generated: 'pdf_text', processor: 'pdfium-2.1.13', page: page.page, page_count: page.count, source_text: true } })
          if (page.needsOCR && page.image) {
            const from = parts.length; await ocr(Buffer.from(page.image))
            for (const part of parts.slice(from)) Object.assign(part.metadata, { page: page.page, page_count: page.count })
          }
          if (settings.vision && page.image) parts.push({ text: `Contenido visual de la página ${page.page}`, metadata: { generated: 'media', modality: 'pdf_page', media_embedding: true, page: page.page, page_count: page.count }, vector: await this.vision.embedMedia({ kind: 'image', image: page.image }, signal) })
          if (!page.text && !settings.vision && !settings.ocr) warnings.push(`Página ${page.page} sin texto extraíble. Activá OCR o el encoder visual para incluir su contenido.`)
        }
      } else if (input.mime_type.startsWith('image/')) {
        if (settings.ocr) { await report({ stage: 'ocr' }); await ocr(input.data) }
        if (settings.vision) { await report({ stage: 'media_embeddings' }); parts.push({ text: 'Contenido visual del archivo', metadata: { generated: 'media', modality: 'image', media_embedding: true }, vector: await this.vision.embedMedia({ kind: 'image', image: input.data }, signal) }) }
      } else if (input.mime_type.startsWith('audio/') || input.mime_type.startsWith('video/')) {
        const ffmpeg = await this.decoder.executable('ffmpeg'), ffprobe = await this.decoder.executable('ffprobe')
        directory = await mkdtemp(join(tmpdir(), 'agenthub-media-'))
        const path = join(directory, 'input'), raw = join(directory, 'audio.f32')
        await writeFile(path, input.data, { mode: 0o600 })
        const probe = JSON.parse(await run(ffprobe, ['-v','error','-protocol_whitelist','file,pipe','-format_whitelist','wav,mp3,flac,ogg,mov,matroska,webm,aac,aiff','-show_format','-show_streams','-of','json',path], signal))
        const duration = Number(probe.format?.duration)
        check(Number.isFinite(duration) && duration > 0 && duration <= MEDIA_MAX_SECONDS, 'El procesamiento local admite archivos de hasta 30 minutos con duración conocida', 422)
        const hasAudio = probe.streams?.some((s: any) => s.codec_type === 'audio'), video = probe.streams?.find((s: any) => s.codec_type === 'video')
        if (hasAudio && (settings.transcription || settings.audio)) {
          await report({ stage: 'media_decode', media_duration_seconds: duration })
          await run(ffmpeg, ['-nostdin','-v','error','-threads','2','-protocol_whitelist','file,pipe','-format_whitelist','wav,mp3,flac,ogg,mov,matroska,webm,aac,aiff','-i',path,'-map','0:a:0','-vn','-t',String(MEDIA_MAX_SECONDS + 1),'-ac','1','-ar','16000','-f','f32le',raw], signal)
          const bytes = await readFile(raw), audio = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
          check(audio.length <= MEDIA_MAX_SECONDS * 16000, 'El audio decodificado supera 30 minutos', 422)
          for (let start = 0; start < audio.length; start += 30 * 16000) {
            signal.throwIfAborted()
            const clip = audio.slice(start, start + 30 * 16000), offset_ms = start / 16, end_offset_ms = (start + clip.length) / 16
            await report({ stage: settings.transcription ? 'transcription' : 'media_embeddings', media_seconds: start / 16000, media_duration_seconds: duration })
            // Silence is not speech; avoid turning digital silence into hallucinated transcripts.
            const audible = Math.sqrt(clip.reduce((sum, value) => sum + value * value, 0) / clip.length) > 0.0001
            if (settings.transcription && audible) {
              const result = await this.speech.transcribe(clip, signal, settings.language)
              for (const chunk of result.chunks ?? []) if (chunk.text.trim()) parts.push({ text: chunk.text.trim(),
                offset_ms: Math.round(offset_ms + Math.max(0, chunk.timestamp[0] * 1000)), metadata: { generated: 'transcription', processor: 'whisper-base-q8-v1',
                  end_offset_ms: Math.round(Math.min(end_offset_ms, offset_ms + (chunk.timestamp[1] ?? clip.length / 16000) * 1000)), review_state: 'pending' } })
            }
            if (settings.audio) parts.push({ text: 'Contenido sonoro del archivo', offset_ms, metadata: { generated: 'media', modality: 'audio', media_embedding: true, end_offset_ms }, vector: await this.audio.embedMedia({ kind: 'audio', audio: clip }, signal) })
          }
        }
        await this.speech.unload(); await this.audio.unload()
        if (video && (settings.vision || settings.ocr)) {
          check(Number(video.width) * Number(video.height) <= 40_000_000, 'La resolución del video supera el límite local', 422)
          await report({ stage: 'media_decode', media_duration_seconds: duration })
          const timestamps = await run(ffmpeg, ['-nostdin','-v','info','-threads','2','-protocol_whitelist','file,pipe','-format_whitelist','wav,mp3,flac,ogg,mov,matroska,webm,aac,aiff','-i',path,'-map','0:v:0','-an','-t',String(MEDIA_MAX_SECONDS),'-vf',`select='isnan(prev_selected_t)+gte(t-prev_selected_t,${VIDEO_FRAME_INTERVAL})',scale=960:960:force_original_aspect_ratio=decrease,showinfo`,'-vsync','vfr','-frames:v','360',join(directory,'frame-%06d.png')], signal, true)
          const times = [...timestamps.matchAll(/\bpts_time:([\d.e+-]+)/g)].map(m => Number(m[1]))
          const frames = (await readdir(directory)).filter(f => /^frame-\d+\.png$/.test(f)).sort()
          check(frames.length === times.length && times.every(Number.isFinite), 'No se pudieron conservar los timestamps del video', 422)
          for (let i = 0; i < frames.length; i += 6) {
            const images: Buffer[] = []
            for (let j = i; j < Math.min(frames.length, i + 6); j++) {
              signal.throwIfAborted(); const image = await readFile(join(directory, frames[j]!)); images.push(image)
              if (settings.ocr) { await report({ stage: 'ocr', media_frame: j + 1, media_frames: frames.length }); await ocr(image, Math.round(times[j]! * 1000)) }
            }
            if (settings.vision && images.length) {
              await report({ stage: 'media_embeddings', media_frame: i + images.length, media_frames: frames.length })
              parts.push({ text: 'Secuencia visual del video', offset_ms: Math.round(times[i]! * 1000),
                metadata: { generated: 'media', modality: 'video', media_embedding: true, frame_interval_seconds: VIDEO_FRAME_INTERVAL, end_offset_ms: Math.round(Math.min(duration, times[i + images.length - 1]! + VIDEO_FRAME_INTERVAL) * 1000) },
                vector: await this.vision.embedMedia({ kind: 'video', frames: images, duration: images.length * VIDEO_FRAME_INTERVAL }, signal) })
            }
          }
        }
        if (!hasAudio && (settings.audio || settings.transcription)) warnings.push('El archivo no contiene una pista de audio.')
      } else throw new MemoryError(422, 'Este formato todavía no admite procesamiento multimedia automático')
      signal.throwIfAborted()
      return { parts, warnings }
    } finally {
      signal.removeEventListener('abort', abortOCR)
      await worker?.terminate().catch(() => {})
      await Promise.all([this.vision.unload(), this.audio.unload(), this.speech.unload()])
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }
  async close() { await Promise.all(MEDIA_MODULES.map(m => this[m].close())) }
}
async function run(command: string, args: string[], signal: AbortSignal, returnStderr = false) {
  signal.throwIfAborted()
  return new Promise<string>((resolve, reject) => execFile(command, args, { signal, timeout: 10 * 60_000, killSignal: 'SIGKILL', maxBuffer: 2_000_000, windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(new MemoryError(signal.aborted ? 499 : 422, signal.aborted ? 'Procesamiento multimedia cancelado' : 'No se pudo decodificar el archivo local; revisá su formato y duración'))
    else resolve(returnStderr ? stderr : stdout)
  }))
}

// Tesseract terminate() does not reject outstanding recognize/init promises.
async function interruptibleOCR<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let timer: NodeJS.Timeout | undefined, abort: () => void = () => {}
  try {
    return await Promise.race([task, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new MemoryError(499, 'OCR cancelado'))
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => reject(new MemoryError(422, 'OCR no respondió a tiempo')), 180_000)
    })])
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}
