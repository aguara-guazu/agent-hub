import { spawnSync, type ChildProcess } from 'node:child_process'
import { rename } from 'node:fs/promises'
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const WINDOWS = process.platform === 'win32'

/** Local absolute file references only; reject UNC and decode percent escapes exactly once. */
export function secretFilePath(raw: string, windows = WINDOWS): string {
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.includes('\0') || /%00/i.test(raw)) {
    throw new Error('ruta local absoluta inválida')
  }
  return fileURLToPath(`file://${raw.replace(/[?#]/g, encodeURIComponent)}`, { windows })
}

/** Hub-internal variables (JWT secret, bootstrap token, Electron-as-Node switch) that third-party children must not inherit. */
const PRIVATE_ENV = /^(?:AGENTHUB_|ELECTRON_RUN_AS_NODE$)/i

/**
 * Environment for third-party children (MCP servers, agent CLIs): the current one minus the hub's private
 * variables, with each layer applied in order and `undefined` removing a key.
 *
 * On Windows variable names are case-insensitive but a plain object copy is not: `{ ...process.env, PATH }`
 * ends up with both `Path` and `PATH`, and Node hands the child only the first in sort order. Keys are
 * upper-cased there so overrides replace instead of duplicating, and so the MCP SDK's own `PATH`/`SYSTEMROOT`
 * defaults merge into the same entries.
 */
export function childEnv(...layers: Array<Record<string, string | undefined> | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  const apply = (key: string, value: string | undefined) => {
    const name = WINDOWS ? key.toUpperCase() : key
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  for (const [key, value] of Object.entries(process.env)) if (!PRIVATE_ENV.test(key)) apply(key, value)
  for (const layer of layers) for (const [key, value] of Object.entries(layer ?? {})) apply(key, value)
  return env
}

type Killable = Pick<ChildProcess, 'pid' | 'kill' | 'exitCode' | 'signalCode'>

/**
 * Ends a child and everything it started.
 *
 * On Windows `kill()` is TerminateProcess of that single process whatever the signal, so whatever runs behind a
 * cmd.exe/npx wrapper or a CLI host survives. `taskkill /T` walks the parent links instead, which only works
 * while the root is still alive: call this before any plain `kill()` of the same child.
 */
export function killTree(child: Killable | number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (typeof child === 'number') {
    const pid = child
    child = { pid, exitCode: null, signalCode: null, kill: (s?: NodeJS.Signals | number) => process.kill(pid, s) }
  }
  if (WINDOWS && child.pid && child.exitCode === null && child.signalCode === null) {
    const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    const result = spawnSync(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
    if (result.status === 0) return
  }
  try { child.kill(signal) } catch { /* already gone */ }
}

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_DELAYS = [20, 40, 80, 160, 320, 640, 1000, 1000]

function busy(error: unknown, attempt: number): boolean {
  return WINDOWS && attempt < RENAME_DELAYS.length && BUSY.has(String((error as NodeJS.ErrnoException).code))
}

/**
 * `rename` that tolerates Windows' transient sharing violations: antivirus scanners, the search indexer and
 * other processes reading the target briefly hold files, and the replace fails with EPERM/EACCES/EBUSY (the
 * same codes graceful-fs retries). Elsewhere it is a plain rename.
 */
export async function renameRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await rename(from, to) } catch (error) {
      if (!busy(error, attempt)) throw error
      await sleep(RENAME_DELAYS[attempt])
    }
  }
}

export function renameRetrySync(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try { return renameSync(from, to) } catch (error) {
      if (!busy(error, attempt)) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_DELAYS[attempt])
    }
  }
}
