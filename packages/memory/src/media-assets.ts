import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { chmod, open, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DECODER_ASSETS, DECODER_RELEASE } from './media-decoder-assets.js'
import { check, MemoryError } from './contracts.js'

export type AssetModule = 'ocr' | 'decoder'
const TESSDATA = 'https://raw.githubusercontent.com/naptha/tessdata/806cd9adc8c6e8abc11c782db1818c990576bebc/4.0.0_fast'
export class MediaAssets {
  readonly directory: string
  private controller: AbortController | undefined
  private task: Promise<void> | undefined
  private closed = false
  private progress: Record<string, unknown> = {}
  private error: string | undefined
  readonly files: { name: string; url: string; sha256: string; bytes?: number }[]
  constructor(directory: string, readonly module: AssetModule) {
    this.directory = join(directory, 'memory', 'models', module === 'ocr' ? 'tesseract-eng-spa-fast-v1' : 'ffmpeg-b6.1.1')
    const platform = `${process.platform}-${process.platform === 'win32' && process.arch === 'arm64' ? 'x64' : process.arch}`
    this.files = module === 'ocr' ? [
      { name: 'eng.traineddata.gz', url: `${TESSDATA}/eng.traineddata.gz`, sha256: '18c1ac52b75e35d44735fb6c2a60acfaf23033524653200738e98f0243edb75b' },
      { name: 'spa.traineddata.gz', url: `${TESSDATA}/spa.traineddata.gz`, sha256: '8db1167a8c9bb015ac8e97278384c3b07dfa9bc8271569beea071d9e296b4487' },
    ] : (DECODER_ASSETS[platform] ?? []).map(a => ({ ...a, url: `${DECODER_RELEASE}/${a.name}`, name: a.name.startsWith('ffmpeg-') ? `ffmpeg${process.platform === 'win32' ? '.exe' : ''}` : a.name.startsWith('ffprobe-') ? `ffprobe${process.platform === 'win32' ? '.exe' : ''}` : a.name }))
  }
  installed() {
    try { return this.files.length > 0 && readFileSync(join(this.directory, 'ready.json'), 'utf8') === JSON.stringify(this.files.map(f => f.sha256)) && this.files.every(f => statSync(join(this.directory, f.name)).size > 0) }
    catch { return false }
  }
  status() { return { state: this.task ? 'downloading' : this.installed() ? 'ready' : this.error ? 'error' : 'missing', ...this.progress, error: this.error } }
  install() {
    check(!this.closed, 'El Hub está cerrado', 503)
    check(this.files.length, 'No hay un decodificador disponible para esta plataforma', 409)
    if (this.task || this.installed()) return this.status()
    this.error = undefined; this.progress = {}; this.controller = new AbortController()
    this.task = this.download(this.controller.signal).catch(e => { this.error = this.controller?.signal.aborted ? 'Descarga cancelada. Podés reintentar.' : e instanceof Error ? e.message : 'Falló la descarga' }).finally(() => { this.task = undefined; this.controller = undefined })
    return this.status()
  }
  private async download(signal: AbortSignal) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    for (const file of this.files) {
      signal.throwIfAborted()
      const path = join(this.directory, file.name), temp = `${path}.download`
      if (existsSync(path) && await fileHash(path) === file.sha256) continue
      const stalled = new AbortController()
      let timer: NodeJS.Timeout | undefined
      const touch = () => { clearTimeout(timer); timer = setTimeout(() => stalled.abort(), 90_000) }
      touch()
      const output = await open(temp, 'w', 0o600)
      try {
        const response = await fetch(file.url, { signal: AbortSignal.any([signal, stalled.signal, AbortSignal.timeout(20 * 60_000)]) })
        check(response.ok && response.body, `No se pudo descargar ${file.name} (HTTP ${response.status})`, 502)
        const digest = createHash('sha256'), total = Number(response.headers.get('content-length')) || file.bytes || 0
        let loaded = 0
        for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
          signal.throwIfAborted(); touch(); loaded += chunk.length
          check(loaded <= (file.bytes ?? 30_000_000), 'La descarga superó el tamaño esperado', 502)
          digest.update(chunk); await output.write(chunk)
          this.progress = { file: file.name, loaded, total, percent: total ? 100 * loaded / total : undefined }
        }
        check(digest.digest('hex') === file.sha256 && (!file.bytes || loaded === file.bytes), 'La descarga no coincide con la huella publicada; reintentá', 502)
        await output.close(); await rename(temp, path)
        if (/^ff(mpeg|probe)/.test(file.name)) await chmod(path, 0o700)
      } finally { clearTimeout(timer); await output.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}) }
    }
    signal.throwIfAborted()
    await writeFile(join(this.directory, 'ready.json'), JSON.stringify(this.files.map(f => f.sha256)), { mode: 0o600 })
  }
  async cancelInstall() { this.controller?.abort(); await this.task; return this.status() }
  async executable(name: 'ffmpeg' | 'ffprobe') {
    check(this.module === 'decoder' && this.installed(), 'Descargá el decodificador de audio y video desde Ajustes', 409)
    const file = this.files.find(f => f.name === `${name}${process.platform === 'win32' ? '.exe' : ''}`)!
    const path = join(this.directory, file.name)
    if (await fileHash(path) !== file.sha256) {
      await rm(join(this.directory, 'ready.json'), { force: true })
      this.error = 'El decodificador local cambió. Reintentá la descarga desde Ajustes.'
      throw new MemoryError(409, this.error)
    }
    return path
  }
  async close() { this.closed = true; await this.cancelInstall() }
}
async function fileHash(path: string) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
