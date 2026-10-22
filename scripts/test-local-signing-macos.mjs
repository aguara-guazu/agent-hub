// Explicit local integration check: requires the identity provisioned by make install-app.
// Never requests folder permissions, launches agents or changes TCC grants.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import signing from '../desktop/scripts/local-signing.cjs'

assert.equal(process.platform, 'darwin', 'This integration check requires macOS')
assert.ok(existsSync(join(homedir(), 'Library', 'Application Support', 'Agent Hub', 'local-signing', 'identity.json')), 'Provision the local signing identity first')
const directory = mkdtempSync(join(tmpdir(), 'agenthub-signing-test-'))
try {
  const first = signing.localIdentity(), second = signing.localIdentity()
  assert.equal(first.fingerprint, second.fingerprint, 'Repeated setup must reuse the identity')
  const snapshots = []
  for (let version = 0; version < 2; version++) {
    const source = join(directory, `v${version}.c`), binary = join(directory, `v${version}`)
    writeFileSync(source, `int main(void) { return ${version}; }\n`)
    execFileSync('/usr/bin/clang', [source, '-o', binary])
    first.run('/usr/bin/codesign', ['--force', '--sign', first.fingerprint, '--keychain', first.keychain, '--timestamp=none', '--identifier', 'io.craftech.agenthub.signing-test', binary])
    first.run('/usr/bin/codesign', ['--verify', '--strict', binary])
    const display = spawnSync('/usr/bin/codesign', ['-d', '-r-', '--verbose=3', binary], { encoding: 'utf8' })
    assert.equal(display.status, 0)
    const output = display.stdout + display.stderr
    const requirement = /^designated => (.+)$/m.exec(output)?.[1], hash = /^CDHash=(.+)$/m.exec(output)?.[1]
    assert.ok(requirement?.includes('certificate leaf = H"'), 'Identity must be bound to the certificate, not only bundle ID')
    assert.ok(hash)
    snapshots.push({ requirement, hash, binary })
  }
  assert.notEqual(snapshots[0].hash, snapshots[1].hash, 'Fixture code must change between builds')
  assert.equal(snapshots[0].requirement, snapshots[1].requirement, 'Code identity must survive changed builds')
  first.run('/usr/bin/codesign', ['--verify', '--strict', `-R=${snapshots[0].requirement}`, snapshots[1].binary])
  console.log('PASS: identity reused; two different binaries satisfy the same certificate-bound requirement; signatures valid.')
} finally { rmSync(directory, { recursive: true, force: true }) }
