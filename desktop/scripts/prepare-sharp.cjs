const { Buffer } = require('node:buffer')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const { mkdir, mkdtemp, readdir, rm, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const tar = require('tar')

// npm ci installs optional native modules for its host. Cross-architecture packages
// need the target's Sharp binding and libvips, even with npmRebuild disabled.
exports.prepareSharp = async (projectDir, appDir, platform, arch) => {
  const lock = JSON.parse(readFileSync(join(projectDir, 'package-lock.json'), 'utf8'))
  const target = `${platform}-${arch}`
  const names = [`sharp-${target}`, ...(platform === 'win32' ? [] : [`sharp-libvips-${target}`])]
  const root = join(appDir, 'node_modules', '@img')
  await mkdir(root, { recursive: true })
  for (const name of names) {
    const entry = lock.packages[`node_modules/@img/${name}`]
    if (!entry?.resolved || !entry.integrity?.startsWith('sha512-')) throw new Error(`Missing pinned native dependency @img/${name}`)
    const destination = join(root, name), manifest = join(destination, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).version === entry.version) continue
    const response = await globalThis.fetch(entry.resolved, { signal: globalThis.AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`Could not download @img/${name}: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== entry.integrity) throw new Error(`Integrity mismatch for @img/${name}`)
    const temp = await mkdtemp(join(tmpdir(), 'agenthub-native-package-'))
    try {
      const file = join(temp, 'package.tgz'); await writeFile(file, bytes)
      await rm(destination, { recursive: true, force: true }); await mkdir(destination, { recursive: true })
      await tar.x({ file, cwd: destination, strip: 1, strict: true })
    } finally { await rm(temp, { recursive: true, force: true }) }
    console.log(`Prepared @img/${name}@${entry.version} (verified lockfile integrity)`)
  }
  for (const name of await readdir(root)) if (name.startsWith('sharp-') && !names.includes(name)) await rm(join(root, name), { recursive: true, force: true })
  if (!(await readdir(join(root, `sharp-${target}`, 'lib'))).some(name => name.startsWith(`sharp-${target}-`) && name.endsWith('.node'))) throw new Error(`Missing Sharp binary for ${target}`)
}
