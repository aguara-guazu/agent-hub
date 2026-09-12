const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

// `identity: null` hace que electron-builder no firme nada, y el bundle queda con la
// firma del enlazador pero sin sello de recursos. Se vuelve a firmar ad hoc para que
// la firma sea internamente consistente. Distribuir a otras Mac sin avisos de
// Gatekeeper sigue requiriendo Developer ID y notarización.
exports.default = async (context) => {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}
