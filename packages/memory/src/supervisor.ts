import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

export class WorkerSupervisor {
  private child: ChildProcess | null = null
  private stopped = true
  private restart: ReturnType<typeof setTimeout> | null = null
  constructor(private directory: string, private redirectUrl: string) {}
  start() {
    if (this.child) return
    this.stopped = false
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url))], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTHUB_MEMORY_DIR: this.directory, AGENTHUB_MEMORY_GOOGLE_REDIRECT: this.redirectUrl },
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    this.child = child
    child.stderr?.resume()
    child.on('error', () => { /* reflected by missing heartbeat in the UI */ })
    child.on('exit', () => {
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
    child.kill('SIGTERM')
    await Promise.race([exited, sleep(5000)])
    if (this.child === child) { child.kill('SIGKILL'); await exited }
  }
}
