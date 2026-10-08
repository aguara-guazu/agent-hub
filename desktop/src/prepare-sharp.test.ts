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
async function fixture() {
  const contents = join(directory, 'archive'), app = join(directory, 'app'), packages: Record<string, unknown> = {}, downloads = new Map<string, Buffer>()
  for (const name of ['sharp-linux-arm64','sharp-libvips-linux-arm64']) {
    await mkdir(join(contents, 'package', 'lib'), { recursive: true })
    await writeFile(join(contents, 'package', 'package.json'), JSON.stringify({ name: `@img/${name}`, version: '1.0.0' }))
    await writeFile(join(contents, 'package', 'lib', 'sharp-linux-arm64-1.0.0.node'), 'fixture')
    const file = join(directory, `${name}.tgz`); await tar.c({ gzip: true, cwd: contents, file }, ['package'])
    const bytes = await readFile(file), resolved = `https://fixture.invalid/${name}.tgz`
    packages[`node_modules/@img/${name}`] = { version: '1.0.0', resolved, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }; downloads.set(resolved, bytes)
  }
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify({ packages }))
  return { app, downloads }
}
it('incluye la arquitectura de destino verificada y retira el binario del host', async () => {
  const { app, downloads } = await fixture()
  await mkdir(join(app, 'node_modules/@img/sharp-linux-x64'), { recursive: true })
  const fetcher = vi.fn(async (url: string) => new Response(new Uint8Array(downloads.get(url)!))); vi.stubGlobal('fetch', fetcher)
  await prepareSharp(directory, app, 'linux', 'arm64')
  expect((await readFile(join(app, 'node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64-1.0.0.node'))).toString()).toBe('fixture')
  await expect(readFile(join(app, 'node_modules/@img/sharp-linux-x64/package.json'))).rejects.toThrow()
  await prepareSharp(directory, app, 'linux', 'arm64'); expect(fetcher).toHaveBeenCalledTimes(2)
})
it('rechaza una descarga alterada antes de extraerla', async () => {
  const { app } = await fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response('corrupted')))
  await expect(prepareSharp(directory, app, 'linux', 'arm64')).rejects.toThrow('Integrity mismatch')
  await expect(readFile(join(app, 'node_modules/@img/sharp-linux-arm64/package.json'))).rejects.toThrow()
})
