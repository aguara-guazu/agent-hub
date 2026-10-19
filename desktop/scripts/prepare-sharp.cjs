const { Buffer } = require('node:buffer')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const { mkdir, mkdtemp, readdir, rm, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const tar = require('tar')

async function installPinned(lock, root, scope, name) {
  const entry = lock.packages[`node_modules/${scope}/${name}`]
  if (!entry?.resolved || !entry.integrity?.startsWith('sha512-')) throw new Error(`Missing pinned native dependency ${scope}/${name}`)
  const destination = join(root, name), manifest = join(destination, 'package.json')
  if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).version === entry.version) return
  const response = await globalThis.fetch(entry.resolved, { signal: globalThis.AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`Could not download ${scope}/${name}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== entry.integrity) throw new Error(`Integrity mismatch for ${scope}/${name}`)
  const temp = await mkdtemp(join(tmpdir(), 'agenthub-native-package-'))
  try {
    const file = join(temp, 'package.tgz'); await writeFile(file, bytes)
    await rm(destination, { recursive: true, force: true }); await mkdir(destination, { recursive: true })
    await tar.x({ file, cwd: destination, strip: 1, strict: true })
  } finally { await rm(temp, { recursive: true, force: true }) }
  console.log(`Prepared ${scope}/${name}@${entry.version} (verified lockfile integrity)`)
}

// npm ci installs optional native modules for its host. Cross-architecture packages
// need the target's Sharp binding and libvips, even with npmRebuild disabled.
// Linux ships the WebAssembly build instead: Electron's Linux binaries link the system glib and leak
// its symbols into the process, and the native libvips then crashes in g_object_unref while decoding
// input images (sharp "Known conflicts: Electron and Linux", electron/electron#46323). Without a
// native package, sharp falls back to @img/sharp-wasm32 by itself.
exports.prepareSharp = async (projectDir, appDir, platform, arch) => {
  const lock = JSON.parse(readFileSync(join(projectDir, 'package-lock.json'), 'utf8'))
  const target = `${platform}-${arch}`, wasm = platform === 'linux'
  const names = wasm ? ['sharp-wasm32'] : [`sharp-${target}`, ...(platform === 'win32' ? [] : [`sharp-libvips-${target}`])]
  const root = join(appDir, 'node_modules', '@img')
  await mkdir(root, { recursive: true })
  for (const name of names) await installPinned(lock, root, '@img', name)
  if (wasm) await installPinned(lock, join(appDir, 'node_modules', '@emnapi'), '@emnapi', 'runtime')
  for (const name of await readdir(root)) if (name.startsWith('sharp-') && !names.includes(name)) await rm(join(root, name), { recursive: true, force: true })
  const binding = names[0]
  if (!(await readdir(join(root, binding, 'lib'))).some(name => name.startsWith(`${binding}-`) && /\.node(\.wasm)?$/.test(name))) throw new Error(`Missing Sharp binary for ${target}`)
}

// Same host-only install problem for the password hasher: a Windows arm64 or macOS x64
// package built on the other architecture would ship without its binding.
exports.prepareArgon2 = async (projectDir, appDir, platform, arch) => {
  const lock = JSON.parse(readFileSync(join(projectDir, 'package-lock.json'), 'utf8'))
  const name = `argon2-${platform}-${arch}${platform === 'win32' ? '-msvc' : platform === 'linux' ? '-gnu' : ''}`
  const root = join(appDir, 'node_modules', '@node-rs')
  if (!existsSync(join(root, 'argon2'))) return
  await installPinned(lock, root, '@node-rs', name)
  for (const entry of await readdir(root)) if (entry.startsWith('argon2-') && entry !== name) await rm(join(root, entry), { recursive: true, force: true })
}

// The terminal transport also needs the target platform's prebuilt N-API binding.
exports.preparePty = async (projectDir, appDir, platform, arch) => {
  const lock = JSON.parse(readFileSync(join(projectDir, 'package-lock.json'), 'utf8'))
  const root = join(appDir, 'node_modules', '@lydell'), name = `node-pty-${platform}-${arch}`
  if (!existsSync(join(root, 'node-pty'))) return
  await installPinned(lock, root, '@lydell', name)
  for (const entry of await readdir(root)) if (entry.startsWith('node-pty-') && entry !== name) await rm(join(root, entry), { recursive: true, force: true })
}
