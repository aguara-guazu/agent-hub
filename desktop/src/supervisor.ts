import { EventEmitter } from 'node:events'
import { spawn as nodeSpawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * Supervisor del core HTTP local.
 *
 * El proceso principal de Electron inicia el core en loopback y lo mantiene
 * vivo mientras la app esté corriendo. Al salir explícitamente (Quit) el
 * supervisor detiene el core de forma ordenada (SIGTERM y, si no responde,
 * SIGKILL). Cerrar la ventana NO detiene el core: eso lo decide el main.
 *
 * El módulo no importa Electron para poder probarse con Node puro; la función
 * de spawn es inyectable.
 */

export type SupervisorState = 'stopped' | 'starting' | 'running' | 'restarting' | 'stopping' | 'failed'

export interface SpawnedProcess {
  readonly pid: number | undefined
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  once(event: 'error', listener: (err: Error) => void): void
}

export type SpawnFn = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => SpawnedProcess

export interface SupervisorOptions {
  /** Ejecutable Node que corre el entrypoint del core. */
  command: string
  /** Argumentos: normalmente [entrypointDelCore, ...]. */
  args: readonly string[]
  /** Variables de entorno adicionales (p. ej. AGENTHUB_* y el puerto de loopback). */
  env?: NodeJS.ProcessEnv
  /** Máximo de reinicios automáticos ante caídas inesperadas. */
  maxRestarts?: number
  /** Ventana en ms para contabilizar reinicios; fuera de ella el contador se reinicia. */
  restartWindowMs?: number
  /** Backoff base entre reinicios. */
  restartBackoffMs?: number
  /** Tiempo de gracia antes del SIGKILL al detener. */
  stopGraceMs?: number
  /** Inyectable para pruebas. */
  spawnFn?: SpawnFn
  /** Inyectable para pruebas: espera ms. */
  sleepFn?: (ms: number) => Promise<void>
}

interface SupervisorEvents {
  state: (state: SupervisorState) => void
  exit: (code: number | null, signal: NodeJS.Signals | null) => void
  log: (line: string) => void
  error: (err: Error) => void
}

const defaultSpawn: SpawnFn = (command, args, env) => {
  // stdin queda abierto como línea de vida: si este proceso muere sin poder detener al
  // hijo (Forzar salida, SIGKILL), el hijo ve el EOF y se apaga solo. Sin esto quedaban
  // core y daemon huérfanos ocupando el puerto, y el siguiente arranque fallaba.
  const child = nodeSpawn(command, [...args], {
    env: { ...env, AGENTHUB_STDIN_LIFELINE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.resume()
  child.stderr.resume()
  return child as unknown as SpawnedProcess
}

export class CoreSupervisor extends EventEmitter {
  private proc: SpawnedProcess | null = null
  private stateValue: SupervisorState = 'stopped'
  private restarts = 0
  private windowStart = 0
  private stopping = false
  private readonly opts: {
    command: string
    args: readonly string[]
    env: NodeJS.ProcessEnv | undefined
    maxRestarts: number
    restartWindowMs: number
    restartBackoffMs: number
    stopGraceMs: number
    spawnFn: SpawnFn
    sleepFn: (ms: number) => Promise<void>
  }

  constructor(options: SupervisorOptions) {
    super()
    this.opts = {
      command: options.command,
      args: options.args,
      env: options.env,
      maxRestarts: options.maxRestarts ?? 5,
      restartWindowMs: options.restartWindowMs ?? 60_000,
      restartBackoffMs: options.restartBackoffMs ?? 500,
      stopGraceMs: options.stopGraceMs ?? 5_000,
      spawnFn: options.spawnFn ?? defaultSpawn,
      sleepFn: options.sleepFn ?? ((ms) => delay(ms)),
    }
  }

  override on<E extends keyof SupervisorEvents>(event: E, listener: SupervisorEvents[E]): this {
    return super.on(event, listener)
  }

  override emit<E extends keyof SupervisorEvents>(event: E, ...args: Parameters<SupervisorEvents[E]>): boolean {
    return super.emit(event, ...args)
  }

  get state(): SupervisorState {
    return this.stateValue
  }

  get pid(): number | undefined {
    return this.proc?.pid
  }

  private setState(next: SupervisorState): void {
    if (this.stateValue === next) return
    this.stateValue = next
    this.emit('state', next)
  }

  /** Arranca el core si no está corriendo. */
  start(): void {
    if (this.proc || this.stateValue === 'starting') return
    this.stopping = false
    this.windowStart = Date.now()
    this.restarts = 0
    this.spawnOnce()
  }

  private spawnOnce(): void {
    this.setState(this.restarts > 0 ? 'restarting' : 'starting')
    let child: SpawnedProcess
    try {
      child = this.opts.spawnFn(this.opts.command, this.opts.args, { ...process.env, ...this.opts.env })
    } catch (err) {
      this.setState('failed')
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
      return
    }
    this.proc = child
    this.setState('running')

    child.once('error', (err) => {
      this.emit('error', err)
    })
    child.once('exit', (code, signal) => {
      this.proc = null
      this.emit('exit', code, signal)
      if (this.stopping) {
        this.setState('stopped')
        return
      }
      void this.handleUnexpectedExit()
    })
  }

  private async handleUnexpectedExit(): Promise<void> {
    const now = Date.now()
    if (now - this.windowStart > this.opts.restartWindowMs) {
      this.windowStart = now
      this.restarts = 0
    }
    this.restarts += 1
    if (this.restarts > this.opts.maxRestarts) {
      this.setState('failed')
      this.emit('error', new Error(`core excedió ${this.opts.maxRestarts} reinicios en la ventana`))
      return
    }
    const backoff = this.opts.restartBackoffMs * this.restarts
    this.setState('restarting')
    await this.opts.sleepFn(backoff)
    if (this.stopping) {
      this.setState('stopped')
      return
    }
    this.spawnOnce()
  }

  /** Detiene el core de forma ordenada: SIGTERM y, si no responde, SIGKILL. */
  async stop(): Promise<void> {
    const child = this.proc
    this.stopping = true
    if (!child) {
      this.setState('stopped')
      return
    }
    this.setState('stopping')
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
    })
    child.kill('SIGTERM')
    const timeout = this.opts.sleepFn(this.opts.stopGraceMs).then(() => 'timeout' as const)
    const result = await Promise.race([exited.then(() => 'exited' as const), timeout])
    if (result === 'timeout' && this.proc) {
      this.proc.kill('SIGKILL')
      await exited
    }
    this.proc = null
    this.setState('stopped')
  }
}
