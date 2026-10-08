import { Worker } from 'node:worker_threads'
import { MemoryError } from './contracts.js'
export interface PDFPage { page: number; count: number; text: string; image?: Uint8Array; needsOCR: boolean }
/** One page at a time: no rasterized pages or full-document images remain on disk. */
export async function* pdfPages(data: Buffer, options: { vision: boolean; ocr: boolean; page?: number }, signal: AbortSignal): AsyncGenerator<PDFPage> {
  signal.throwIfAborted()
  const worker = new Worker(new URL('./pdf-worker.js', import.meta.url), { workerData: { data }, resourceLimits: { maxOldGenerationSizeMb: 256 } })
  let pending: { resolve: (value: any) => void; reject: (error: Error) => void } | undefined, timer: NodeJS.Timeout | undefined
  const fail = (error: Error) => { pending?.reject(error); pending = undefined; void worker.terminate() }
  const abort = () => fail(new MemoryError(499, 'Procesamiento PDF cancelado'))
  const wait = () => new Promise<any>((resolve, reject) => { pending = { resolve, reject }; timer = setTimeout(() => fail(new MemoryError(422, 'El lector PDF no respondió a tiempo')), 180_000) })
  worker.on('message', value => {
    clearTimeout(timer)
    if (value.type === 'error') fail(new MemoryError(422, value.message))
    else { pending?.resolve(value); pending = undefined }
  })
  worker.on('error', () => fail(new MemoryError(422, 'El lector PDF no pudo procesar este archivo')))
  worker.on('exit', () => { if (pending) fail(new MemoryError(422, 'El lector PDF se cerró antes de terminar')) })
  signal.addEventListener('abort', abort, { once: true })
  try {
    const { count } = await wait()
    const first = options.page === undefined ? 0 : options.page - 1, end = options.page === undefined ? count : options.page
    if (!Number.isInteger(first) || first < 0 || end > count) throw new MemoryError(422, 'La página no existe en este PDF')
    let characters = 0
    for (let index = first; index < end; index++) {
      signal.throwIfAborted()
      const response = wait(); worker.postMessage({ index, vision: options.vision, ocr: options.ocr })
      const page = await response as PDFPage
      characters += page.text.length
      if (characters > 2_000_000) throw new MemoryError(422, 'El PDF supera dos millones de caracteres; dividilo en documentos más pequeños')
      yield page
    }
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); await worker.terminate() }
}
export async function pdfPreview(data: Buffer, page: number, signal = new AbortController().signal) {
  for await (const result of pdfPages(data, { page, vision: true, ocr: false }, signal)) return { data: Buffer.from(result.image!), page: result.page, pages: result.count }
  throw new MemoryError(422, 'El PDF no contiene la página solicitada')
}
