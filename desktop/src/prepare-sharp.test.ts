import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const require = createRequire(import.meta.url), { prepareSharp } = require('../scripts/prepare-sharp.cjs'), tar = require('tar')
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sharp-packaging-test-')) })
afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }) })
async function fixture(names: string[], file: string) {
  const app = join(directory, 'app'), packages: Record<string, unknown> = {}, downloads = new Map<string, Buffer>()
  for (const name of names) {
    const contents = join(directory, 'archive', name)
    await mkdir(join(contents, 'package', 'lib'), { recursive: true })
    await writeFile(join(contents, 'package', 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    await writeFile(join(contents, 'package', 'lib', file), 'fixture')
    const archive = join(directory, `${name.replace('/', '__')}.tgz`); await tar.c({ gzip: true, cwd: contents, file: archive }, ['package'])
    const bytes = await readFile(archive), resolved = `https://fixture.invalid/${name}.tgz`
    packages[`node_modules/${name}`] = { version: '1.0.0', resolved, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }; downloads.set(resolved, bytes)
  }
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify({ packages }))
  return { app, downloads }
}
it('incluye la arquitectura de destino verificada y retira el binario del host', async () => {
  const { app, downloads } = await fixture(['@img/sharp-darwin-arm64', '@img/sharp-libvips-darwin-arm64'], 'sharp-darwin-arm64-1.0.0.node')
  await mkdir(join(app, 'node_modules/@img/sharp-linux-x64'), { recursive: true })
  const fetcher = vi.fn(async (url: string) => new Response(new Uint8Array(downloads.get(url)!))); vi.stubGlobal('fetch', fetcher)
  await prepareSharp(directory, app, 'darwin', 'arm64')
  expect((await readFile(join(app, 'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-1.0.0.node'))).toString()).toBe('fixture')
  await expect(readFile(join(app, 'node_modules/@img/sharp-linux-x64/package.json'))).rejects.toThrow()
  await prepareSharp(directory, app, 'darwin', 'arm64'); expect(fetcher).toHaveBeenCalledTimes(2)
})
it('en Linux empaqueta el build WebAssembly verificado y retira los binarios nativos', async () => {
  const { app, downloads } = await fixture(['@img/sharp-wasm32', '@emnapi/runtime'], 'sharp-wasm32-1.0.0.node.wasm')
  for (const name of ['sharp-linux-x64', 'sharp-libvips-linux-x64']) await mkdir(join(app, 'node_modules/@img', name), { recursive: true })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(new Uint8Array(downloads.get(url)!))))
  await prepareSharp(directory, app, 'linux', 'x64')
  expect((await readFile(join(app, 'node_modules/@img/sharp-wasm32/lib/sharp-wasm32-1.0.0.node.wasm'))).toString()).toBe('fixture')
  expect(JSON.parse(await readFile(join(app, 'node_modules/@emnapi/runtime/package.json'), 'utf8')).name).toBe('@emnapi/runtime')
  await expect(readFile(join(app, 'node_modules/@img/sharp-linux-x64/package.json'))).rejects.toThrow()
  await expect(readFile(join(app, 'node_modules/@img/sharp-libvips-linux-x64/package.json'))).rejects.toThrow()
})
it('rechaza una descarga alterada antes de extraerla', async () => {
  const { app } = await fixture(['@img/sharp-darwin-arm64', '@img/sharp-libvips-darwin-arm64'], 'sharp-darwin-arm64-1.0.0.node')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('corrupted')))
  await expect(prepareSharp(directory, app, 'darwin', 'arm64')).rejects.toThrow('Integrity mismatch')
  await expect(readFile(join(app, 'node_modules/@img/sharp-darwin-arm64/package.json'))).rejects.toThrow()
})
