import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import { killTree } from '@agenthub/gateway/platform'
import { LogFile } from './report.js'

/** The desktop app passes its logs folder; a standalone core keeps the log next to the memory. */
export const workerLogPath = (directory: string) => join(process.env.AGENTHUB_LOG_DIR || join(directory, 'logs'), 'worker.log')

export class WorkerSupervisor {
  private child: ChildProcess | null = null
  private stopped = true
  private restart: ReturnType<typeof setTimeout> | null = null
  readonly log: LogFile
  constructor(private directory: string, private redirectUrl: string) {
    this.log = new LogFile(workerLogPath(directory))
  }
  start() {
    if (this.child) return
    this.stopped = false
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url))], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTHUB_MEMORY_DIR: this.directory, AGENTHUB_MEMORY_GOOGLE_REDIRECT: this.redirectUrl },
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    this.child = child
    if (child.stderr) this.log.follow(child.stderr)
    child.on('error', error => this.log.write(`[supervisor] no se pudo iniciar el worker: ${error.message}`))
    child.on('exit', (code, signal) => {
      // A native crash (SIGTRAP, SIGSEGV) writes nothing to stderr: this line is its only trace in the job reports.
      if (!this.stopped || code) this.log.write(`[supervisor] el worker terminó (código ${code ?? '-'}, señal ${signal ?? '-'})`)
      if (this.child === child) this.child = null
      if (!this.stopped) { this.restart = setTimeout(() => this.start(), 5000); this.restart.unref() }
    })
  }
  async stop() {
    this.stopped = true
    if (this.restart) clearTimeout(this.restart)
    const child = this.child
    if (!child) return
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    // The worker winds down its jobs when stdin ends. On Windows kill() is an immediate TerminateProcess that leaves
    // claimed jobs 'running' until their lease expires, so the signal is only sent elsewhere.
    child.stdin?.end()
    if (process.platform !== 'win32') child.kill('SIGTERM')
    await Promise.race([exited, sleep(10_000)])
    if (this.child === child) { killTree(child, 'SIGKILL'); await exited }
  }
}
