import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { prepareModelFiles } from '../src/model-download.js'
import { MediaAssets } from '../src/media-assets.js'
const fixture = vi.hoisted(() => ({ bytes: new Uint8Array([1,2,3,4,5,6]), sha256: '' }))
vi.mock('../src/model-files.js', () => ({ MODEL_FILES: { gemma: { 'weights': { bytes: 6, get sha256() { return fixture.sha256 } } } } }))
vi.mock('../src/media-models.js', () => ({ modelProfile: () => ({ repository: 'owner/model', revision: 'pinned', files: ['weights'] }) }))
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'media-download-test-')); fixture.sha256 = createHash('sha256').update(fixture.bytes).digest('hex') })
afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }) })
const weights = () => join(directory, 'owner/model/pinned/weights')
it('reanuda un parcial por Range y sólo publica pesos íntegros; inferencia no descarga', async () => {
  const file = weights(); await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.part-vision`, fixture.bytes.slice(0,2))
  const fetcher = vi.fn(async (_url: string, options: any) => { expect(options.headers.Range).toBe('bytes=2-5'); return new Response(fixture.bytes.slice(2), { status: 206, headers: { 'content-range': 'bytes 2-5/6' } }) }); vi.stubGlobal('fetch', fetcher)
  const progress = vi.fn(); await prepareModelFiles(directory, 'vision', true, progress)
  expect(await readFile(file)).toEqual(Buffer.from(fixture.bytes)); expect(progress).toHaveBeenCalledWith(expect.objectContaining({ loaded: 6, progress: 100 }))
  await prepareModelFiles(directory, 'vision', false, progress); expect(fetcher).toHaveBeenCalledTimes(1)
  await rm(file); await expect(prepareModelFiles(directory, 'vision', false, progress)).rejects.toThrow('incompleto'); expect(fetcher).toHaveBeenCalledTimes(1)
})
it('rechaza rangos y huellas incorrectas sin publicar un modelo', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(fixture.bytes, { status: 200 })))
  await expect(prepareModelFiles(directory, 'vision', true, () => {})).rejects.toThrow('reanudar')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(6), { status: 206, headers: { 'content-range': 'bytes 0-5/6' } })))
  await expect(prepareModelFiles(directory, 'vision', true, () => {})).rejects.toThrow('huella')
  await expect(readFile(weights())).rejects.toThrow(); await expect(readFile(`${weights()}.part-vision`)).rejects.toThrow()
})
async function settle(assets: MediaAssets) { for (let i=0; i<200 && assets.status().state === 'downloading'; i++) await new Promise(r => setTimeout(r, 5)); expect(assets.status().state).not.toBe('downloading') }
it('verifica herramientas descargadas y permite reparar una copia local alterada', async () => {
  const assets = new MediaAssets(directory, 'decoder'), name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  assets.files.splice(0, assets.files.length, { name, url: 'https://fixture.invalid/binary', sha256: fixture.sha256, bytes: 6 })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(fixture.bytes)))
  try {
    assets.install(); await settle(assets); expect(assets.installed()).toBe(true)
    const path = await assets.executable('ffmpeg'); await writeFile(path, 'changed')
    await expect(assets.executable('ffmpeg')).rejects.toThrow('Reintentá'); expect(assets.status().state).toBe('error')
    assets.install(); await settle(assets); expect(await assets.executable('ffmpeg')).toBe(path)
  } finally { await assets.close() }
})
it('cancelar una descarga no deja un módulo listo y permite reintentar', async () => {
  const assets = new MediaAssets(directory, 'ocr')
  assets.files.splice(0, assets.files.length, { name: 'fixture', url: 'https://fixture.invalid/data', sha256: fixture.sha256, bytes: 6 })
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: any) => new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }) })))
  try {
    assets.install(); await new Promise(r => setTimeout(r,20)); await assets.cancelInstall(); expect(assets.status().state).toBe('error'); expect(assets.installed()).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(fixture.bytes))); assets.install(); await settle(assets); expect(assets.installed()).toBe(true)
  } finally { await assets.close() }
})
