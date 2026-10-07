// Managed PostgreSQL from the pre-SQLite memory (`runtime.json`), used only as the migration source.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const execute = promisify(execFile)
// Las apps abiertas por launchd/Finder no reciben LANG ni LC_ALL; sin locale, postmaster en
// macOS aborta con "postmaster became multithreaded during startup". El cluster usa --locale=C.
const postgresEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: 'C' })
interface Runtime { backend: string; pg_ctl?: string; port: number; docker?: string; compose?: string; project?: string }
function runtime(directory: string): Runtime | null {
  const path = join(directory, 'runtime.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Runtime : null
}
let lastChecked = 0
export async function startManagedDatabase(directory: string, force = false) {
  if (!force && Date.now() - lastChecked < 30_000) return
  lastChecked = Date.now()
  const config = runtime(directory)
  if (!config) return
  if (config.backend === 'native' && config.pg_ctl) {
    const data = join(directory, 'postgres')
    try { await execute(config.pg_ctl, ['-D', data, 'status'], { timeout: 5000, env: postgresEnv() }); return } catch { /* start our own initialized cluster */ }
    await execute(config.pg_ctl, ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-p ${config.port} -h 127.0.0.1 -c unix_socket_directories=''`, '-w', 'start'], { timeout: 30_000, env: postgresEnv() })
  } else if (config.backend === 'docker' && config.docker && config.compose) {
    await execute(config.docker, ['compose', '-f', config.compose, '-p', config.project ?? 'agenthub-memory', 'up', '-d'], { timeout: 60_000, env: { ...process.env, AGENTHUB_MEMORY_DIR: directory, AGENTHUB_MEMORY_PORT: String(config.port) } })
  }
}
/** Stops the hub-managed cluster after a verified migration; its data directory is left in place. */
export async function stopManagedDatabase(directory: string) {
  const config = runtime(directory)
  if (config?.backend === 'native' && config.pg_ctl) {
    await execute(config.pg_ctl, ['-D', join(directory, 'postgres'), '-m', 'fast', '-w', 'stop'], { timeout: 30_000, env: postgresEnv() })
  } else if (config?.backend === 'docker' && config.docker && config.compose) {
    await execute(config.docker, ['compose', '-f', config.compose, '-p', config.project ?? 'agenthub-memory', 'stop'], { timeout: 60_000, env: { ...process.env, AGENTHUB_MEMORY_DIR: directory, AGENTHUB_MEMORY_PORT: String(config.port) } })
  }
}
