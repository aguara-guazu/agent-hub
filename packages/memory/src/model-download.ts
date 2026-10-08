import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { modelProfile, type InferenceProfile } from './media-models.js'
import { MODEL_FILES } from './model-files.js'

/** Range requests bound each transfer; partial, verified-length progress survives a cancelled installation. */
export async function prepareModelFiles(cache: string, profile: InferenceProfile, install: boolean, progress: (value: any) => void) {
  const model = modelProfile(profile), files = MODEL_FILES[profile === 'speech' ? 'speech' : 'gemma']!
  for (const name of model.files) {
    const expected = files[name]
    if (!expected) continue
    const path = join(cache, model.repository, model.revision, name), size = await stat(path).then(s => s.size, () => 0)
    if (size === expected.bytes && (!install || await digest(path) === expected.sha256)) continue
    if (!install) throw new Error('El modelo local está incompleto. Reintentá su descarga desde Ajustes.')
    const partial = `${path}.part-${profile}`
    await mkdir(dirname(path), { recursive: true })
    if (size > 0 && size < expected.bytes && !await stat(partial).catch(() => null)) await copyFile(path, partial)
    let offset = await stat(partial).then(s => s.size, () => 0)
    if (offset > expected.bytes) { await rm(partial, { force: true }); offset = 0 }
    const file = await open(partial, 'a')
    try {
      while (offset < expected.bytes) {
        const end = Math.min(offset + 8 * 1024 * 1024, expected.bytes) - 1
        const response = await fetch(`https://huggingface.co/${model.repository}/resolve/${model.revision}/${name}`, {
          headers: { Range: `bytes=${offset}-${end}` }, signal: AbortSignal.timeout(180_000),
        })
        if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${offset}-${end}/${expected.bytes}` || !response.body) {
          await response.body?.cancel(); throw new Error('El servidor no pudo reanudar la descarga del modelo. Reintentá desde Ajustes.')
        }
        let received = 0
        for await (const data of response.body as any as AsyncIterable<Uint8Array>) {
          if (offset + data.length > end + 1) throw new Error('El servidor devolvió una descarga de tamaño inesperado')
          await file.write(data); offset += data.length; received += data.length
          progress({ status: 'progress', file: name, loaded: offset, total: expected.bytes, progress: offset * 100 / expected.bytes })
        }
        if (!received) throw new Error('La descarga no avanzó. Reintentá desde Ajustes.')
      }
    } finally { await file.close() }
    if (await digest(partial) !== expected.sha256) { await rm(partial, { force: true }); throw new Error('La descarga del modelo no coincide con su huella. Reintentá desde Ajustes.') }
    await rename(partial, path)
  }
}
async function digest(path: string) {
  const hash = createHash('sha256')
  for await (const data of createReadStream(path)) hash.update(data)
  return hash.digest('hex')
}
