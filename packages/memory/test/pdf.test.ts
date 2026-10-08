import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { pdfFixture } from './pdf-fixture.js'
import { pdfPages, pdfPreview } from '../src/pdf.js'
import { MediaRuntime, mediaSettingsInput } from '../src/media-runtime.js'
// Compile only the isolated worker, keeping this test runnable before the app build.
const fixture = vi.hoisted(() => ({ worker: '' }))
vi.mock('node:worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof import('node:worker_threads')>()
  return { ...actual, Worker: class extends actual.Worker {
    constructor(path: URL | string, options: import('node:worker_threads').WorkerOptions) {
      super(String(path).endsWith('/pdf-worker.js') ? fixture.worker : path, options)
    }
  } }
})
let directory: string, pdf: Buffer
beforeAll(async () => {
  const cache = fileURLToPath(new URL('../../../node_modules/.cache/', import.meta.url))
  await mkdir(cache, { recursive: true }); directory = await mkdtemp(`${cache}pdf-test-`)
  fixture.worker = `${directory}/worker.mjs`
  await build({ entryPoints: [fileURLToPath(new URL('../src/pdf-worker.ts', import.meta.url))], outfile: fixture.worker, bundle: true, packages: 'external', platform: 'node', format: 'esm' })
  pdf = pdfFixture(await sharp({ create: { width: 300, height: 100, channels: 3, background: 'red' } }).jpeg().toBuffer())
})
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })
it('lee texto por página, detecta escaneos y renderiza imágenes sin descargar componentes', async () => {
  const pages = []
  for await (const page of pdfPages(pdf, { vision: false, ocr: true }, new AbortController().signal)) pages.push(page)
  expect(pages).toHaveLength(2)
  expect(pages[0]).toMatchObject({ page: 1, count: 2, needsOCR: false })
  expect(pages[0]!.text).toContain('Aurora budget approved')
  expect(pages[0]!.image).toBeUndefined()
  expect(pages[1]).toMatchObject({ page: 2, needsOCR: true, text: '' })
  expect((await sharp(pages[1]!.image).metadata()).format).toBe('png')
  const preview = await pdfPreview(pdf, 1)
  expect(preview).toMatchObject({ page: 1, pages: 2 })
  expect((await sharp(preview.data).stats()).channels[0]!.mean).toBeGreaterThan((await sharp(preview.data).stats()).channels[1]!.mean)
})
it('produce evidencia textual y visual con página y avisa sobre escaneos sin módulos', async () => {
  const runtime = new MediaRuntime(directory), signal = new AbortController().signal
  const embed = vi.spyOn(runtime.vision, 'embedMedia').mockResolvedValue([1, ...Array(767).fill(0)])
  try {
    const plain = await runtime.process({ data: pdf, mime_type: 'application/pdf', filename: 'evidence.pdf' }, mediaSettingsInput.parse({}), signal, async () => {})
    expect(plain.parts[0]).toMatchObject({ metadata: { generated: 'pdf_text', page: 1, page_count: 2 } })
    expect(plain.warnings).toHaveLength(1)
    const visual = await runtime.process({ data: pdf, mime_type: 'application/pdf', filename: 'evidence.pdf' }, mediaSettingsInput.parse({ vision: true }), signal, async () => {})
    expect(embed).toHaveBeenCalledTimes(2)
    expect(visual.parts.filter(p => p.vector).map(p => p.metadata.page)).toEqual([1, 2])
    expect(visual.warnings).toEqual([])
  } finally { await runtime.close() }
})
it('rechaza PDF inválido, página inexistente, límites y cancelación sin resultados parciales', async () => {
  await expect(pdfPreview(Buffer.from('invalid'), 1)).rejects.toThrow('válido')
  await expect(pdfPreview(pdf, 3)).rejects.toThrow('no existe')
  const large = pdfFixture(await sharp({ create: { width: 300, height: 100, channels: 3, background: 'white' } }).jpeg().toBuffer(), 201)
  await expect(pdfPreview(large, 1)).rejects.toThrow('200 páginas')
  const controller = new AbortController(), pages = pdfPages(pdf, { vision: true, ocr: false }, controller.signal)
  const reading = pages.next(), rejected = expect(reading).rejects.toThrow('cancelado')
  controller.abort(); await rejected
})
