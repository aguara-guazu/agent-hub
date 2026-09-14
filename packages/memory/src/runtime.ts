import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const execute = promisify(execFile)
let lastChecked = 0
export async function startManagedDatabase(directory: string) {
  if (Date.now() - lastChecked < 30_000) return
  lastChecked = Date.now()
  const path = join(directory, 'runtime.json')
  if (!existsSync(path)) return
  const config = JSON.parse(readFileSync(path, 'utf8')) as { backend: string; pg_ctl?: string; port: number; docker?: string; compose?: string; project?: string }
  if (config.backend === 'native' && config.pg_ctl) {
    const data = join(directory, 'postgres')
    try { await execute(config.pg_ctl, ['-D', data, 'status'], { timeout: 5000 }); return } catch { /* start our own initialized cluster */ }
    await execute(config.pg_ctl, ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-p ${config.port} -h 127.0.0.1 -c unix_socket_directories=''`, '-w', 'start'], { timeout: 30_000 })
  } else if (config.backend === 'docker' && config.docker && config.compose) {
    await execute(config.docker, ['compose', '-f', config.compose, '-p', config.project ?? 'agenthub-memory', 'up', '-d'], { timeout: 60_000, env: { ...process.env, AGENTHUB_MEMORY_DIR: directory, AGENTHUB_MEMORY_PORT: String(config.port) } })
  }
}
