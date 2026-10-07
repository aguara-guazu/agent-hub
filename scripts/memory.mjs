import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryService } from '../packages/memory/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2), command = args[0] ?? 'up'
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback }
const appState = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Agent Hub')
  : process.platform === 'win32' ? join(process.env.APPDATA || homedir(), 'Agent Hub') : join(homedir(), '.config', 'Agent Hub')
const directory = resolve(option('--dir', process.env.AGENTHUB_MEMORY_DIR || (command === 'dev' ? join(root, '.agenthub', 'memory-development') : join(appState, 'memory'))))
function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env }, cwd: root })
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`El comando terminó con código ${code}`)))
  })
}
async function prepare() {
  const service = new MemoryService(directory, 'http://127.0.0.1:8765/api/memory/google/callback')
  try { await service.get() } finally { await service.close() }
}

if (command === 'down') {
  // Only the PostgreSQL cluster managed by earlier versions remains to stop; the SQLite memory has no service.
  const path = join(directory, 'runtime.json')
  if (!existsSync(path)) throw new Error('No hay un PostgreSQL administrado en ese directorio')
  const runtime = JSON.parse(readFileSync(path, 'utf8'))
  if (runtime.backend === 'native') await run(runtime.pg_ctl, ['-D', join(directory, 'postgres'), '-m', 'fast', '-w', 'stop'], { LC_ALL: 'C' })
  else await run(runtime.docker, ['compose', '-f', runtime.compose, '-p', runtime.project ?? 'agenthub-memory', 'stop'], { AGENTHUB_MEMORY_DIR: directory, AGENTHUB_MEMORY_PORT: String(runtime.port) })
} else if (command === 'test') {
  await run(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'packages/memory/test', 'packages/core/test/memory.test.ts', '--no-file-parallelism'])
} else {
  await prepare()
  if (command === 'demo' || command === 'dev') {
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
  console.log(`Memoria preparada en ${join(directory, 'memory.sqlite')}.`)
}
