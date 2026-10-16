/** Native macOS update through a local release server, using disposable app bundles and profiles. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

assert.equal(process.platform, 'darwin', 'This native smoke test requires macOS')
const run = promisify(execFile), root = await mkdtemp(join(tmpdir(), 'hub-silent-update-'))
const bundle = resolve(process.argv[2] ?? 'release/mac-arm64/Agent Hub.app')
const current = join(root, 'installed', 'Agent Hub.app'), payload = join(root, 'payload'), next = join(payload, 'Agent Hub.app')
const eventsFile = join(root, 'events.jsonl'), profile = join(root, 'profile'), home = join(root, 'home')
const dmg = join(root, 'update.dmg'), executable = join(current, 'Contents/MacOS/Agent Hub')
let child, server, completed = false, downloads = 0
const pids = new Set()
async function events() { return (await readFile(eventsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
async function until(label, predicate, ms = 120_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await predicate()) return; await delay(300) }
  throw new Error(`Timeout: ${label}`)
}
try {
  await mkdir(join(root, 'installed')); await mkdir(payload); await mkdir(home); await mkdir(join(root, 'tmp'))
  await run('ditto', [bundle, current])
  // Instrument only the disposable fixture. Record native window/notification events;
  // suppress actual notifications to avoid disturbing the person running the smoke test.
  const probe = `\nimport { app as probeApp, Notification as ProbeNotification } from 'electron';\nimport { appendFileSync as probeAppend } from 'node:fs';\nconst probeLog = type => probeAppend(process.env.AGENTHUB_UPDATE_PROBE, JSON.stringify({type,pid:process.pid,version:probeApp.getVersion(),args:process.argv.slice(1)})+'\\n');\nProbeNotification.prototype.show = function(){ probeLog('notification') };\nprobeApp.on('browser-window-created',(_event,win)=>{probeLog('window');win.on('show',()=>probeLog('show'))});\nprobeApp.whenReady().then(()=>probeLog('ready'));\n`
  await appendFile(join(current, 'Contents/Resources/app/desktop/dist/entry.js'), probe)
  await run('ditto', [current, next])
  const jsonPath = join(next, 'Contents/Resources/app/package.json'), pkg = JSON.parse(await readFile(jsonPath, 'utf8'))
  const originalVersion = pkg.version, targetVersion = `${Number(pkg.version.split('.')[0]) + 1}.0.0`
  pkg.version = targetVersion; await writeFile(jsonPath, JSON.stringify(pkg))
  await run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleShortVersionString ${targetVersion}`, join(next, 'Contents/Info.plist')])
  await run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleVersion ${targetVersion}`, join(next, 'Contents/Info.plist')])
  for (const app of [current, next]) await run('codesign', ['--force', '--deep', '--sign', '-', app])
  await run('hdiutil', ['create', '-quiet', '-ov', '-format', 'UDZO', '-srcfolder', payload, dmg], { timeout: 180_000 })
  const hash = createHash('sha256'); for await (const chunk of createReadStream(dmg)) hash.update(chunk)
  const digest = `sha256:${hash.digest('hex')}`, size = (await stat(dmg)).size
  let base
  server = createServer((request, response) => {
    if (request.url.endsWith('/releases/latest')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ tag_name: `v${targetVersion}`, assets: [{ name: `AgentHub-${process.arch}.dmg`, browser_download_url: `${base}/update.dmg`, digest, size }] }))
    } else if (request.url === '/update.dmg') {
      downloads++; response.setHeader('content-length', size); createReadStream(dmg).pipe(response)
    } else { response.statusCode = 404; response.end() }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  const portProbe = createServer(); await new Promise(r => portProbe.listen(0, '127.0.0.1', r))
  const port = portProbe.address().port; await new Promise(r => portProbe.close(r))
  const env = { ...process.env, TMPDIR: join(root, 'tmp'), AGENTHUB_UPDATE_API: base, AGENTHUB_UPDATE_PROBE: eventsFile, AGENTHUB_DESKTOP_STATE_DIR: profile, AGENTHUBD_HOME_DIR: home,
    AGENTHUB_MEMORY_DIR: join(profile, 'memory'), AGENTHUB_HUB_PORT: String(port), AGENTHUB_STARTER_CATALOG: '0', AGENTHUB_MEMORY_WORKER: '0' }
  delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTHUB_NO_AUTO_UPDATE
  child = spawn(executable, ['--hidden', '--updated'], { env, stdio: ['ignore', 'ignore', 'pipe'] }); pids.add(child.pid)
  let logs = ''; child.stderr.on('data', data => { logs += data.toString() })
  await until('new version restarts and creates hidden window', async () => {
    const rows = await events(); rows.forEach(row => pids.add(row.pid))
    return rows.some(row => row.type === 'window' && row.version === targetVersion)
  })
  await until('restarted local API is healthy', async () => { try { return (await globalThis.fetch(`http://127.0.0.1:${port}/health`)).ok } catch { return false } })
  await delay(1500)
  const rows = await events(), newRows = rows.filter(row => row.version === targetVersion)
  assert.ok(rows.some(row => row.version === originalVersion)); assert.ok(pids.size >= 2)
  assert.ok(newRows.every(row => row.args.includes('--hidden') && row.args.includes('--updated')))
  assert.equal(rows.filter(row => row.type === 'show' || row.type === 'notification').length, 0)
  assert.equal(downloads, 1)
  assert.equal(JSON.parse(await readFile(join(current, 'Contents/Resources/app/package.json'), 'utf8')).version, targetVersion)
  await writeFile(join(root, 'report.json'), JSON.stringify({ status: 'passed', originalVersion, targetVersion, downloads, events: rows, logs }, null, 2))
  completed = true; console.log(`PASS native silent update: downloaded, verified, installed, relaunched hidden; API healthy; zero window shows/notifications. Evidence: ${root}/report.json`)
} finally {
  for (const row of await events()) pids.add(row.pid)
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* Process already exited. */ } }
  await delay(2000)
  // Only processes whose executable is the disposable app are eligible for cleanup.
  const { stdout } = await run('ps', ['-Ao', 'pid=,command='])
  for (const line of stdout.split('\n')) if (line.includes(executable)) { try { process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL') } catch { /* Process already exited. */ } }
  await new Promise(r => server ? server.close(r) : r())
  if (completed) { await rm(join(root, 'installed'), { recursive: true, force: true }); await rm(payload, { recursive: true, force: true }); await rm(dmg, { force: true }) }
  else console.error(`Failed native update evidence: ${root}`)
}
