import { parentPort, workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { PDFiumLibrary } from '@hyzyla/pdfium'
import sharp from 'sharp'
const require = createRequire(import.meta.url)
// Supply the bundled WASM bytes explicitly; PDF processing never fetches a decoder.
globalThis.fetch = async () => { throw new Error('El lector PDF local no accede a la red') }
try {
  const wasm = await readFile(require.resolve('@hyzyla/pdfium/pdfium.wasm'))
  const library = await PDFiumLibrary.init({ wasmBinary: new Uint8Array(wasm).buffer })
  if (workerData.checkRuntime) {
    await sharp({ create: { width: 2, height: 2, channels: 4, background: 'white' } }).png().toBuffer()
    library.destroy(); parentPort!.postMessage({ type: 'runtime-ready' })
  } else {
    const document = await library.loadDocument(new Uint8Array(workerData.data))
    const count = document.getPageCount()
    if (count < 1 || count > 200) throw new Error('El procesamiento PDF admite entre 1 y 200 páginas')
    parentPort!.postMessage({ type: 'ready', count })
    parentPort!.on('message', async ({ index, vision, ocr }) => {
      try {
        if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('La página no existe en este PDF')
        const page = document.getPage(index), text = page.getText().trim(), size = page.getOriginalSize()
        if (text.length > 500_000) throw new Error('Una página supera el límite local de texto')
        const needsOCR = ocr && text.length < 40
        let image: Uint8Array | undefined
        if (vision || needsOCR) {
          const dimension = Math.max(size.originalWidth, size.originalHeight)
          if (!Number.isFinite(dimension) || dimension <= 0 || dimension > 1_000_000) throw new Error('El PDF contiene una página con dimensiones inválidas')
          const rendered = await page.render({ scale: Math.min(2, 1600 / dimension), renderFormFields: false,
            render: async ({ data, width, height }) => sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer() })
          image = rendered.data
        }
        parentPort!.postMessage({ type: 'page', page: index + 1, count, text, image, needsOCR })
      } catch (error) { parentPort!.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'No se pudo leer la página PDF' }) }
    })
  }
} catch (error) {
  const message = error instanceof Error ? error.message : ''
  parentPort!.postMessage({ type: 'error', message: /páginas|dimensiones|límite/.test(message) ? message : 'No se pudo abrir el PDF. Verificá que sea válido y no requiera contraseña.' })
}
