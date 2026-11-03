const { execFileSync } = require('node:child_process')
const { dirname, join } = require('node:path')
const { copyFileSync, readdirSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { Buffer } = require('node:buffer')
const { createPublicKey } = require('node:crypto')
const { Arch } = require('builder-util')
const { prepareArgon2, prepareSharp, preparePty } = require('./prepare-sharp.cjs')

const CRT = /^(?:msvcp140|vcruntime140)[\w]*\.dll$/i

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/

/**
 * Trust store embedded from CI (`AGENTHUB_UPDATE_TRUST` JSON or the file named by `AGENTHUB_UPDATE_TRUST_FILE`).
 * Same rules the updater applies when loading it (update-trust.ts parseTrustSet): only {id, ed25519_spki_b64}
 * entries, unique ids, keys that decode as DER SPKI Ed25519, revocations as unique ids, and at least one key that
 * is not revoked. Any violation fails the build: a store the updater would reject must never ship.
 */
function canonicalTrustStore() {
  const inline = process.env.AGENTHUB_UPDATE_TRUST
  const source = inline ?? (process.env.AGENTHUB_UPDATE_TRUST_FILE ? readFileSync(process.env.AGENTHUB_UPDATE_TRUST_FILE, 'utf8') : null)
  if (!source) return null
  const fail = (reason) => { throw new Error(`AGENTHUB_UPDATE_TRUST inválido: ${reason}`) }
  const trust = JSON.parse(source)
  if (!trust || typeof trust !== 'object' || trust.schema !== 1 || !Array.isArray(trust.keys) || !Array.isArray(trust.revoked)) fail('se espera {schema:1, keys:[], revoked:[]}')
  if (Object.keys(trust).some(name => !['schema', 'keys', 'revoked'].includes(name))) fail('campos desconocidos')
  const ids = new Set()
  const keys = trust.keys.map(entry => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(name => name !== 'id' && name !== 'ed25519_spki_b64')) fail('cada clave es {id, ed25519_spki_b64}')
    if (typeof entry.id !== 'string' || !KEY_ID.test(entry.id) || ids.has(entry.id)) fail(`id de clave inválido o repetido: ${entry.id}`)
    let key
    try { key = createPublicKey({ key: Buffer.from(entry.ed25519_spki_b64, 'base64'), format: 'der', type: 'spki' }) } catch { key = null }
    if (typeof entry.ed25519_spki_b64 !== 'string' || key?.asymmetricKeyType !== 'ed25519') fail(`la clave ${entry.id} no es Ed25519 DER SPKI`)
    ids.add(entry.id)
    return { id: entry.id, ed25519_spki_b64: entry.ed25519_spki_b64 }
  })
  if (!trust.revoked.every(id => typeof id === 'string' && KEY_ID.test(id)) || new Set(trust.revoked).size !== trust.revoked.length) fail('revocaciones inválidas o repetidas')
  if (!keys.some(key => !trust.revoked.includes(key.id))) fail('se necesita al menos una clave no revocada')
  return JSON.stringify({ schema: 1, keys: keys.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), revoked: [...trust.revoked].sort() })
}

function embedTrustStore(appDir) {
  const trust = canonicalTrustStore()
  if (!trust) return
  const output = join(appDir, 'desktop', 'dist', 'update-trust.json')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, trust, { encoding: 'utf8', mode: 0o644 })
}

function compileSwapHelper(projectDir, resources) {
  const outputDir = join(resources, 'bin'), output = join(outputDir, 'agenthub-swap')
  mkdirSync(outputDir, { recursive: true })
  execFileSync('clang', ['-arch', 'arm64', '-O2', '-Wall', '-Werror', '-o', output, join(projectDir, 'desktop', 'scripts', 'agenthub-swap.c')], { stdio: 'inherit' })
}

/** Folder with the Visual C++ runtime DLLs for `arch` from the newest MSVC redist installed on this Windows builder. */
function vcRuntimeFolder(arch) {
  const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!existsSync(vswhere)) return null
  const install = execFileSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' }).trim()
  const redist = join(install, 'VC', 'Redist', 'MSVC')
  if (!install || !existsSync(redist)) return null
  const versions = readdirSync(redist).filter(name => /^\d+\.\d+/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const version of versions) {
    const folder = join(redist, version, arch === 'ia32' ? 'x86' : arch)
    const crt = existsSync(folder) && readdirSync(folder).find(name => /^Microsoft\.VC\d+\.CRT$/.test(name))
    if (crt) return join(folder, crt)
  }
  return null
}

/**
 * Native addons built with MSVC import the Visual C++ runtime dynamically and Electron does not ship it, so on a
 * machine without the VC++ 2015-2022 redistributable they fail with "module could not be found". libuv loads
 * addons with LOAD_WITH_ALTERED_SEARCH_PATH: the addon's own folder is searched first for its dependencies, so a
 * copy next to each addon that imports the runtime is enough (app-local deployment).
 */
function bundleVcRuntime(appDir, arch) {
  const source = vcRuntimeFolder(arch)
  if (!source) {
    const message = `No se encontró el runtime de Visual C++ (${arch}) para empaquetar junto a los módulos nativos`
    if (process.platform === 'win32') throw new Error(message)
    console.warn(`${message}; el paquete depende de que el equipo tenga el redistribuible instalado`)
    return
  }
  const runtime = readdirSync(source).filter(name => CRT.test(name))
  const folders = new Set()
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(node|dll)$/i.test(entry.name) && !CRT.test(entry.name) && /(?:vcruntime|msvcp)140/i.test(readFileSync(path).toString('latin1'))) folders.add(dirname(path))
    }
  }
  walk(join(appDir, 'node_modules'))
  for (const folder of folders) for (const name of runtime) copyFileSync(join(source, name), join(folder, name))
  console.log(`Bundled the Visual C++ runtime (${runtime.join(', ')}) next to ${folders.size} native module folder(s)`)
}

// `identity: null` hace que electron-builder no firme nada, y el bundle queda con la
// firma del enlazador pero sin sello de recursos. Se vuelve a firmar ad hoc para que
// la firma sea internamente consistente. Distribuir a otras Mac sin avisos de
// Gatekeeper sigue requiriendo Developer ID y notarización.
exports.default = async (context) => {
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  await preparePty(context.packager.projectDir, join(resources, 'app'), context.electronPlatformName, Arch[context.arch])
  await prepareSharp(context.packager.projectDir, join(resources, 'app'), context.electronPlatformName, Arch[context.arch])
  await prepareArgon2(context.packager.projectDir, join(resources, 'app'), context.electronPlatformName, Arch[context.arch])
  embedTrustStore(join(resources, 'app'))
  const binaries = join(resources, 'app', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6')
  // The npm package includes bindings for five targets. Ship only the current platform/architecture.
  if (existsSync(binaries)) for (const platform of readdirSync(binaries)) {
    const directory = join(binaries, platform)
    if (platform !== context.electronPlatformName) rmSync(directory, { recursive: true, force: true })
    else for (const arch of readdirSync(directory)) if (arch !== Arch[context.arch]) rmSync(join(directory, arch), { recursive: true, force: true })
  }
  if (context.electronPlatformName === 'win32') bundleVcRuntime(join(resources, 'app'), Arch[context.arch])
  if (context.electronPlatformName === process.platform && Arch[context.arch] === process.arch) {
    execFileSync(process.execPath, [join(context.packager.projectDir, 'scripts', 'verify-embedding-runtime.mjs'),
      join(resources, 'app', 'packages', 'memory', 'dist', 'embedding-worker.js')], { stdio: 'inherit' })
  }
  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (Arch[context.arch] === 'arm64') compileSwapHelper(context.packager.projectDir, resources)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}
