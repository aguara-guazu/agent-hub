// Local installations only. Never use this machine-specific identity for public releases.
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } = require('node:fs')
const { homedir } = require('node:os')
const { join, resolve } = require('node:path')
const { randomBytes, X509Certificate } = require('node:crypto')

function localIdentity(directory = join(homedir(), 'Library', 'Application Support', 'Agent Hub', 'local-signing')) {
  if (process.platform !== 'darwin') throw new Error('La firma local requiere macOS.')
  const passwordFile = join(directory, 'keychain-password'), keychain = join(directory, 'identity.keychain-db')
  const certificate = join(directory, 'certificate.pem'), metadata = join(directory, 'identity.json')
  const password = existsSync(passwordFile) ? readFileSync(passwordFile, 'utf8') : randomBytes(32).toString('hex')
  function run(command, args) {
    try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }) }
    catch (error) {
      // execFile's default error includes argv, which can contain keychain credentials.
      const detail = String(error.stderr ?? '').replaceAll(password, '[redacted]').slice(0, 2000)
      throw new Error(`${command} no pudo completar la firma local. ${detail}`)
    }
  }
  if (!existsSync(metadata)) {
    if (existsSync(directory)) throw new Error(`La identidad local está incompleta en ${directory}. No se generó otra para evitar perder permisos; revisá esa instalación.`)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(passwordFile, password, { mode: 0o600, flag: 'wx' })
    const privateKey = join(directory, 'private-key.pem'), archive = join(directory, 'identity.p12')
    const config = join(directory, 'certificate.cnf')
    writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=Agent Hub Local Development\n[extensions]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning\n', { mode: 0o600 })
    try {
      run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', privateKey, '-out', certificate, '-days', '3650', '-config', config])
      chmodSync(privateKey, 0o600)
      run('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', privateKey, '-in', certificate, '-out', archive, '-passout', `file:${passwordFile}`])
      chmodSync(archive, 0o600)
      run('/usr/bin/security', ['create-keychain', '-p', password, keychain])
      run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain])
      run('/usr/bin/security', ['import', archive, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign'])
      run('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain])
      writeFileSync(metadata, JSON.stringify({ fingerprint: new X509Certificate(readFileSync(certificate)).fingerprint.replaceAll(':', '') }), { mode: 0o600, flag: 'wx' })
    } finally {
      for (const file of [privateKey, archive, config]) rmSync(file, { force: true })
    }
  }
  const { fingerprint } = JSON.parse(readFileSync(metadata, 'utf8'))
  if (!/^[A-F0-9]{40}$/.test(fingerprint) || new X509Certificate(readFileSync(certificate)).fingerprint.replaceAll(':', '') !== fingerprint) throw new Error('La identidad local no coincide con su certificado; no se reemplazó.')
  run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain])
  // codesign also resolves the certificate chain through the user's search list.
  // Keep the existing entries and default keychain; add only our dedicated one.
  const searchList = run('/usr/bin/security', ['list-keychains', '-d', 'user']).split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line))
  if (!searchList.includes(keychain)) run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...searchList, keychain])
  const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', keychain])
  if (!identities.includes(fingerprint)) {
    console.error('macOS puede pedir confirmar el certificado local de Agent Hub. Su confianza se limita a firma de código y a este usuario.')
    run('/usr/bin/security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', keychain, certificate])
    if (!run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', keychain]).includes(fingerprint)) throw new Error('macOS todavía no reconoce la identidad local. La app instalada no se modificó.')
  }
  return { fingerprint, keychain, run }
}

function signLocalApp(appPath) {
  const app = resolve(appPath)
  const bundleId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
  if (bundleId !== 'io.craftech.agenthub') throw new Error('Sólo se admite el bundle de Agent Hub.')
  const { fingerprint, keychain, run } = localIdentity()
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', fingerprint, '--keychain', keychain, '--timestamp=none', app])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  console.log('Firma local persistente verificada. Las próximas instalaciones reutilizarán esta identidad.')
}
module.exports = { localIdentity, signLocalApp }
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Uso: node desktop/scripts/local-signing.cjs "/ruta/Agent Hub.app"')
    signLocalApp(process.argv[2])
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
