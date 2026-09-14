import { spawn, execFileSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { Vault, MemoryService, MemoryDatabase } from '../packages/memory/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2), command = args[0] ?? 'up'
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback }
const appState = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Agent Hub')
  : process.platform === 'win32' ? join(process.env.APPDATA || homedir(), 'Agent Hub') : join(homedir(), '.config', 'Agent Hub')
const directory = resolve(option('--dir', process.env.AGENTHUB_MEMORY_DIR || (command === 'test' ? join(root, '.agenthub', 'memory-tests') : command === 'dev' ? join(root, '.agenthub', 'memory-development') : join(appState, 'memory'))))
const runtimePath = join(directory, 'runtime.json')
const existing = existsSync(runtimePath) ? JSON.parse(readFileSync(runtimePath, 'utf8')) : null
const port = Number(option('--port', String(existing?.port ?? (command === 'test' ? 54339 : command === 'dev' ? 54349 : 54329))))
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Puerto inválido')
const vault = new Vault(directory)
function which(name) {
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }).trim().split('\n')[0] }
  catch { return null }
}
function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env }, cwd: root })
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`El comando terminó con código ${code}`)))
  })
}
async function prepare() {
  mkdirSync(join(directory, 'secrets'), { recursive: true, mode: 0o700 })
  const backend = option('--backend', existing?.backend ?? (which('docker') ? 'docker' : 'native'))
  const passwordPath = join(directory, 'secrets', 'postgres-password')
  if (!existsSync(passwordPath)) writeFileSync(passwordPath, randomBytes(32).toString('base64url'), { mode: 0o600 })
  const password = readFileSync(passwordPath, 'utf8').trim()
  if (backend === 'docker') {
    const docker = which('docker')
    if (!docker) throw new Error('Instalá Docker o usá --backend native con PostgreSQL y pgvector')
    const compose = join(directory, 'compose.yml')
    writeFileSync(compose, readFileSync(join(root, 'compose.memory.yml')), { mode: 0o600 })
    const project = existing?.project ?? `agenthub-memory-${createHash('sha256').update(directory).digest('hex').slice(0, 10)}`
    await run(docker, ['compose', '-f', compose, '-p', project, 'up', '-d'], { AGENTHUB_MEMORY_DIR: directory, AGENTHUB_MEMORY_PORT: String(port) })
    writeFileSync(runtimePath, JSON.stringify({ backend, docker, compose, project, port }), { mode: 0o600 })
  } else if (backend === 'native') {
    const pgCtl = which('pg_ctl'), initdb = which('initdb')
    if (!pgCtl || !initdb) throw new Error('Instalá PostgreSQL 17 y pgvector, o usá Docker')
    const data = join(directory, 'postgres')
    if (!existsSync(join(data, 'PG_VERSION'))) await run(initdb, ['-D', data, '-U', 'agenthub', '-A', 'scram-sha-256', '--pwfile', passwordPath, '--encoding=UTF8', '--locale=C'])
    try { execFileSync(pgCtl, ['-D', data, 'status'], { stdio: 'ignore' }) }
    catch { await run(pgCtl, ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1 -c unix_socket_directories=''`, '-w', 'start']) }
    writeFileSync(runtimePath, JSON.stringify({ backend, pg_ctl: pgCtl, port }), { mode: 0o600 })
  } else throw new Error('Backend desconocido')
  const adminUrl = `postgresql://agenthub:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`
  const admin = new pg.Pool({ connectionString: adminUrl, connectionTimeoutMillis: 1000 })
  try {
    let connected = false
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await admin.query('SELECT 1'); connected = true; break } catch { await sleep(1000) }
    }
    if (!connected) throw new Error('PostgreSQL no quedó disponible; revisá el log del servicio')
    const name = command === 'test' ? 'agenthub_memory_test' : 'agenthub_memory'
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rows.length) await admin.query(`CREATE DATABASE ${name}`)
    const url = adminUrl.replace(/\/postgres$/, `/${name}`)
    if (command !== 'test') vault.save('database', { url })
    const db = new MemoryDatabase(url)
    try { await db.migrate() } finally { await db.close() }
    return url
  } finally { await admin.end() }
}

if (command === 'down') {
  const path = join(directory, 'runtime.json')
  if (!existsSync(path)) throw new Error('No hay un servicio administrado en ese directorio')
  const runtime = JSON.parse(readFileSync(path, 'utf8'))
  if (runtime.backend === 'native') await run(runtime.pg_ctl, ['-D', join(directory, 'postgres'), '-m', 'fast', '-w', 'stop'])
  else await run(runtime.docker, ['compose', '-f', runtime.compose, '-p', runtime.project ?? 'agenthub-memory', 'stop'], { AGENTHUB_MEMORY_DIR: directory, AGENTHUB_MEMORY_PORT: String(runtime.port) })
} else {
  const url = await prepare()
  if (command === 'test') await run(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'packages/memory/test', 'packages/core/test/memory.test.ts', '--no-file-parallelism'], { AGENTHUB_MEMORY_TEST_URL: url, AGENTHUB_MEMORY_TEST_DIR: directory })
  else if (command === 'demo' || command === 'dev') {
    const { seedDemo } = await import('../packages/memory/dist/demo.js')
    const service = new MemoryService(directory, 'http://127.0.0.1:8765/api/memory/google/callback')
    try { await seedDemo((await service.get()).store) } finally { await service.close() }
    console.log('Datos de ejemplo cargados.')
    if (command === 'dev') {
      process.env.AGENTHUB_MEMORY_DIR = directory
      const { buildApp, ensureLocalOwner, createAccessToken } = await import('@agenthub/core')
      const hubPort = Number(option('--hub-port', '8876'))
      const base = `http://127.0.0.1:${hubPort}`
      const app = buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(directory, 'hub.db'),
        jwtSecret: randomBytes(32).toString('hex'), consoleDist: join(root, 'frontend/dist'), oauthDir: join(directory, 'oauth'), oauthRedirectUrl: `${base}/api/oauth/callback` } })
      const { default: staticPlugin } = await import('@fastify/static')
      await app.fastify.register(staticPlugin, { root: join(root, 'frontend/dist'), prefix: '/', wildcard: false })
      await app.fastify.listen({ host: '127.0.0.1', port: hubPort })
      const token = await createAccessToken(app.settings, ensureLocalOwner(app.store).id)
      console.log(`Hub de demostración en ${base}. Ctrl+C detiene la UI y el worker; los datos se conservan.`)
      if (args.includes('--smoke')) {
        try {
          const { smokeMemoryUI } = await import('../frontend/scripts/memory-smoke.mjs')
          await smokeMemoryUI({ base, token, directory })
        } finally { await app.fastify.close(); app.db.close() }
      } else {
        if (!args.includes('--no-open')) {
          const address = `${base}/?sso_token=${encodeURIComponent(token)}#/projects`
          const opener = process.platform === 'darwin' ? ['open', [address]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', address]] : ['xdg-open', [address]]
          const child = spawn(opener[0], opener[1], { stdio: 'ignore' })
          child.on('error', () => console.error('No se pudo abrir el navegador. Reiniciá sin --no-open con un navegador disponible.'))
        }
        await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
        await app.fastify.close(); app.db.close()
      }
    }
  } else if (command !== 'up') throw new Error('Usá up, down, demo, dev o test')
  console.log(`Memoria preparada en ${directory}. PostgreSQL escucha sólo en 127.0.0.1:${port}.`)
}
