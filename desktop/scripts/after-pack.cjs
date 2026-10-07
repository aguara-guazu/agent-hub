const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { readdirSync, rmSync, existsSync } = require('node:fs')
const { Arch } = require('builder-util')

// `identity: null` hace que electron-builder no firme nada, y el bundle queda con la
// firma del enlazador pero sin sello de recursos. Se vuelve a firmar ad hoc para que
// la firma sea internamente consistente. Distribuir a otras Mac sin avisos de
// Gatekeeper sigue requiriendo Developer ID y notarización.
exports.default = async (context) => {
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const binaries = join(resources, 'app', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6')
  // The npm package includes bindings for five targets. Ship only the current platform/architecture.
  if (existsSync(binaries)) for (const platform of readdirSync(binaries)) {
    const directory = join(binaries, platform)
    if (platform !== context.electronPlatformName) rmSync(directory, { recursive: true, force: true })
    else for (const arch of readdirSync(directory)) if (arch !== Arch[context.arch]) rmSync(join(directory, arch), { recursive: true, force: true })
  }
  if (context.electronPlatformName === process.platform && Arch[context.arch] === process.arch) {
    execFileSync(process.execPath, [join(context.packager.projectDir, 'scripts', 'verify-embedding-runtime.mjs'),
      join(resources, 'app', 'packages', 'memory', 'dist', 'embedding-worker.js')], { stdio: 'inherit' })
  }
  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}
