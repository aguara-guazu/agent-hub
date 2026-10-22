import { spawn, execFile, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

export type FleetState = 'starting' | 'busy' | 'idle' | 'stopped' | 'failed' | 'unknown'
export interface FleetStart {
  id: string
  cli: 'claude_code' | 'codex_cli'
  cwd: string
  model: string
  effort?: string
  prompt: string
  resume_id?: string
}
/** Deliberately contains no prompt, response, transcript, command output or CLI error text. */
export interface FleetStatus {
  id: string
  cli: FleetStart['cli']
  state: FleetState
  cwd: string
  model: string
  effort?: string
  native_id?: string
  turn_id?: string
  error_code?: string
}
export type FleetEvent = FleetStatus
export interface FleetProcessOptions {
  launcher?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams
  onEvent?: (event: FleetEvent) => void | Promise<void>
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
}
type Packet = Record<string, any>
type Pending = { resolve: (value: Packet) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
type Session = {
  status: FleetStatus
  child: ChildProcessWithoutNullStreams
  closed: Promise<void>
  exited: boolean
  stopping: boolean
  seq: number
  pending: Map<number, Pending>
  expectedNative: string | undefined
  ready: { resolve: () => void; reject: (error: Error) => void } | undefined
  submitting: boolean
  completedTurns: Set<string>
  eventQueue: Promise<void>
  cleanup: Promise<void> | undefined
}

/** Owns only children launched by this manager. Nothing is written to directory or to a log. */
export class FleetProcessManager {
  private sessions = new Map<string, Session>()
  private closing = false
  private starting = new Set<string>()
  constructor(readonly directory: string, private options: FleetProcessOptions = {}) {}

  status(id: string): FleetStatus | undefined {
    const value = this.sessions.get(id)?.status
    return value ? { ...value } : undefined
  }
  list(): FleetStatus[] { return [...this.sessions.values()].map(s => ({ ...s.status })) }

  private publish(s: Session, state: FleetState, error_code?: string) {
    if (this.sessions.get(s.status.id) !== s) return
    s.status.state = state
    if (error_code) s.status.error_code = error_code
    else delete s.status.error_code
    const event = { ...s.status }
    // Serialize writes so a slow busy callback cannot overwrite a later idle callback.
    s.eventQueue = s.eventQueue.then(() => this.options.onEvent?.(event)).then(() => {}, () => {
      // Persistence failure cannot produce an unhandled rejection or claim healthy work.
      this.fail(s, 'fleet_event_delivery_failed')
    })
  }
  private live(s: Session) {
    return this.sessions.get(s.status.id) === s && !s.exited && !s.stopping && !['failed', 'stopped'].includes(s.status.state)
  }
  private write(s: Session, packet: Packet) {
    if (!this.live(s) || !s.child.stdin.writable) throw new Error('fleet_process_unavailable')
    s.child.stdin.write(JSON.stringify(packet) + '\n')
  }
  private request(s: Session, method: string, params: Packet): Promise<Packet> {
    const id = ++s.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        s.pending.delete(id)
        reject(new Error('fleet_protocol_timeout'))
      }, this.options.requestTimeoutMs ?? 30_000)
      s.pending.set(id, { resolve, reject, timer })
      try { this.write(s, { jsonrpc: '2.0', id, method, params }) }
      catch (error) { clearTimeout(timer); s.pending.delete(id); reject(error) }
    })
  }
  private rejectPending(s: Session, code: string) {
    for (const p of s.pending.values()) { clearTimeout(p.timer); p.reject(new Error(code)) }
    s.pending.clear()
    s.ready?.reject(new Error(code)); s.ready = undefined
  }
  private fail(s: Session, code: string) {
    if (this.sessions.get(s.status.id) !== s || s.stopping || s.status.state === 'failed') return
    this.publish(s, 'failed', code)
    this.rejectPending(s, code)
    void this.terminate(s)
  }
  private receive(s: Session, packet: Packet) {
    if (!this.live(s)) return
    if (s.status.cli === 'claude_code') {
      if (packet.type === 'system' && packet.subtype === 'init') {
        if (typeof packet.session_id !== 'string' || packet.session_id !== s.expectedNative) {
          this.fail(s, 'fleet_session_mismatch'); return
        }
        s.status.native_id = packet.session_id
        this.publish(s, 'busy')
        s.ready?.resolve(); s.ready = undefined
      } else if (packet.type === 'result') {
        if (packet.session_id !== s.status.native_id || !s.status.native_id) {
          this.fail(s, 'fleet_session_mismatch'); return
        }
        if (typeof packet.uuid === 'string') {
          if (s.completedTurns.has(packet.uuid)) return
          s.completedTurns.add(packet.uuid)
          if (s.completedTurns.size > 256) s.completedTurns.delete(s.completedTurns.values().next().value!)
        }
        if (s.status.state !== 'busy') return
        delete s.status.turn_id
        if (packet.is_error || packet.subtype !== 'success') this.fail(s, 'fleet_turn_failed')
        else this.publish(s, 'idle')
      }
      return
    }
    if (packet.id !== undefined && !packet.method) {
      const pending = s.pending.get(packet.id)
      if (!pending) return
      clearTimeout(pending.timer); s.pending.delete(packet.id)
      if (packet.error) pending.reject(new Error('fleet_rpc_error'))
      else pending.resolve(packet.result ?? {})
      return
    }
    if (packet.id !== undefined && packet.method) {
      // Never grant unexpected server requests, even in a fully authorized child.
      this.write(s, { id: packet.id, error: { code: -32601, message: 'Unsupported fleet client request' } })
      this.fail(s, 'fleet_unexpected_server_request')
      return
    }
    const params = packet.params ?? {}
    if (params.threadId !== s.status.native_id || !s.status.native_id) return
    if (packet.method === 'turn/started' && typeof params.turn?.id === 'string') {
      if (s.completedTurns.has(params.turn.id)) return
      if (!s.submitting && s.status.turn_id !== params.turn.id) return
      s.status.turn_id = params.turn.id
      this.publish(s, 'busy')
    }
    if (packet.method === 'turn/completed' && params.turn?.id === s.status.turn_id) {
      const turn = params.turn
      s.completedTurns.add(turn.id)
      if (s.completedTurns.size > 256) s.completedTurns.delete(s.completedTurns.values().next().value!)
      delete s.status.turn_id
      if (turn.status === 'completed' || turn.status === 'interrupted') this.publish(s, 'idle')
      else this.fail(s, turn.status === 'failed' ? 'fleet_turn_failed' : 'fleet_invalid_turn_status')
    }
    if (packet.method === 'error' && params.willRetry === false) this.fail(s, 'fleet_turn_failed')
  }

  async start(input: FleetStart): Promise<FleetStatus> {
    if (this.starting.has(input.id)) throw new Error('fleet_already_running')
    this.starting.add(input.id)
    try { return await this.startSession(input) } finally { this.starting.delete(input.id) }
  }
  private async startSession(input: FleetStart): Promise<FleetStatus> {
    if (this.closing) throw new Error('fleet_manager_closed')
    if (!input.id || !input.model || !isAbsolute(input.cwd) || !['claude_code', 'codex_cli'].includes(input.cli)) throw new Error('fleet_invalid_start')
    const old = this.sessions.get(input.id)
    if (old) {
      if (!['stopped', 'failed'].includes(old.status.state)) throw new Error('fleet_already_running')
      await this.terminate(old)
      await old.eventQueue
      if (this.closing) throw new Error('fleet_manager_closed')
    }
    const expectedNative = input.cli === 'claude_code' ? input.resume_id ?? randomUUID() : input.resume_id
    const args = input.cli === 'claude_code'
      ? ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--model', input.model,
        ...(input.effort ? ['--effort', input.effort] : []), ...(input.resume_id ? ['--resume', input.resume_id] : ['--session-id', expectedNative!])]
      : ['app-server', '--listen', 'stdio://']
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^(AGENTHUB_|ORCA_|ELECTRON_RUN_AS_NODE$|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CODEX_THREAD_ID$)/i.test(key)) delete env[key]
    const launcher = this.options.launcher ?? ((command, argv, options) => spawn(command, argv, { ...options, stdio: 'pipe' }))
    const child = launcher(input.cli === 'claude_code' ? 'claude' : 'codex', args, { cwd: input.cwd, env, detached: process.platform !== 'win32', windowsHide: true })
    const status: FleetStatus = { id: input.id, cli: input.cli, cwd: input.cwd, model: input.model, state: 'starting', ...(input.effort ? { effort: input.effort } : {}) }
    let closed!: () => void
    const s: Session = { status, child, closed: new Promise(resolve => { closed = resolve }), exited: false, stopping: false, seq: 0,
      pending: new Map(), expectedNative, ready: undefined, submitting: false, completedTurns: new Set(), eventQueue: Promise.resolve(), cleanup: undefined }
    this.sessions.set(input.id, s)
    this.publish(s, 'starting')
    child.stdin.on('error', () => this.fail(s, 'fleet_stdin_failed'))
    child.stderr.resume() // Drain without retaining or exposing output.
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (!this.live(s)) return
      buffer += chunk
      // Bound both incomplete lines and parsed packets. Tool output is never retained.
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        if (line.length > 8_388_608) { this.fail(s, 'fleet_protocol_packet_too_large'); return }
        try {
          const packet: unknown = JSON.parse(line)
          if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error()
          this.receive(s, packet as Packet)
        } catch { this.fail(s, 'fleet_invalid_protocol'); return }
      }
      if (buffer.length > 8_388_608) this.fail(s, 'fleet_protocol_packet_too_large')
    })
    child.once('error', () => { this.fail(s, 'fleet_spawn_failed'); s.exited = true; closed() })
    child.once('exit', () => {
      s.exited = true
      if (!s.stopping && s.status.state !== 'failed') this.fail(s, 'fleet_process_exited')
    })
    child.once('close', () => {
      s.exited = true; buffer = ''; closed()
      if (!s.stopping && s.status.state !== 'failed') this.fail(s, 'fleet_process_exited')
      this.rejectPending(s, 'fleet_process_exited')
    })
    try {
      if (input.cli === 'codex_cli') {
        await this.request(s, 'initialize', { clientInfo: { name: 'agent-hub-fleet', version: '1' }, capabilities: { experimentalApi: false } })
        this.write(s, { method: 'initialized' })
        const result = await this.request(s, input.resume_id ? 'thread/resume' : 'thread/start', {
          cwd: input.cwd, model: input.model, approvalPolicy: 'never', sandbox: 'danger-full-access',
          ...(input.resume_id ? { threadId: input.resume_id } : {}),
        })
        if (typeof result.thread?.id !== 'string' || !result.thread.id || (input.resume_id && result.thread.id !== input.resume_id)) throw new Error('fleet_session_mismatch')
        s.status.native_id = result.thread.id
        await this.submit(s, input.prompt)
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined
        const ready = new Promise<void>((resolve, reject) => {
          s.ready = { resolve, reject }
          timer = setTimeout(() => reject(new Error('fleet_protocol_timeout')), this.options.requestTimeoutMs ?? 30_000)
        })
        try { this.writeClaude(s, input.prompt); await ready } finally { clearTimeout(timer); s.ready = undefined }
      }
    } catch (error) {
      const code = error instanceof Error && /^fleet_[a-z_]+$/.test(error.message) ? error.message : 'fleet_start_failed'
      this.fail(s, code)
    }
    if (s.stopping && s.cleanup) await s.cleanup
    await s.eventQueue
    return { ...s.status }
  }
  private writeClaude(s: Session, text: string) {
    // The user message UUID is the local correlation ID; Claude supplies the native session ID.
    s.status.turn_id = randomUUID()
    this.write(s, { type: 'user', uuid: s.status.turn_id, session_id: s.expectedNative, message: { role: 'user', content: text }, parent_tool_use_id: null })
  }
  private async submit(s: Session, text: string) {
    s.submitting = true
    try {
      const response = await this.request(s, 'turn/start', { threadId: s.status.native_id, input: [{ type: 'text', text }],
        model: s.status.model, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, ...(s.status.effort ? { effort: s.status.effort } : {}) })
      const id = response.turn?.id
      if (typeof id !== 'string' || !id) throw new Error('fleet_missing_turn_id')
      // Notifications can finish the turn before the RPC response arrives.
      if (this.live(s) && !s.completedTurns.has(id)) {
        s.status.turn_id = id
        this.publish(s, 'busy')
        if (response.turn.status === 'failed') this.fail(s, 'fleet_turn_failed')
        else if (['completed', 'interrupted'].includes(response.turn.status)) this.receive(s, { method: 'turn/completed', params: { threadId: s.status.native_id, turn: response.turn } })
      }
    } finally { s.submitting = false }
  }
  async send(id: string, text: string): Promise<FleetStatus> {
    const s = this.sessions.get(id)
    if (!s || !this.live(s) || s.status.state !== 'idle' || s.submitting) throw new Error('fleet_not_idle')
    try {
      if (s.status.cli === 'codex_cli') await this.submit(s, text)
      else { this.writeClaude(s, text); this.publish(s, 'busy') }
    } catch { this.fail(s, 'fleet_send_failed') }
    await s.eventQueue
    return { ...s.status }
  }
  async interrupt(id: string): Promise<FleetStatus> {
    const s = this.sessions.get(id)
    if (!s || !this.live(s)) throw new Error('fleet_process_unavailable')
    if (s.status.state !== 'busy') throw new Error('fleet_not_busy')
    try {
      if (s.status.cli === 'codex_cli') {
        if (!s.status.turn_id) throw new Error('fleet_missing_turn_id')
        await this.request(s, 'turn/interrupt', { threadId: s.status.native_id, turnId: s.status.turn_id })
      } else this.write(s, { type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
      // Only a result/completed notification can mark the worker idle.
    } catch { this.fail(s, 'fleet_interrupt_failed') }
    await s.eventQueue
    return { ...s.status }
  }
  private signal(s: Session, signal: NodeJS.Signals) {
    if (!s.child.pid) return
    try {
      if (process.platform !== 'win32') process.kill(-s.child.pid, signal)
      else if (!s.exited) execFile('taskkill', ['/PID', String(s.child.pid), '/T', '/F'], { timeout: 1_000, windowsHide: true }, () => {})
    } catch { /* An already exited owned process/group needs no action. */ }
  }
  private terminate(s: Session): Promise<void> {
    if (s.cleanup) return s.cleanup
    s.cleanup = (async () => {
      s.stopping = true
      this.rejectPending(s, 'fleet_process_stopped')
      s.child.stdin.destroy()
      this.signal(s, 'SIGTERM')
      const delay = this.options.shutdownTimeoutMs ?? 1_000
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([s.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, delay) })])
      } finally { clearTimeout(timer) }
      // Also reap descendants if the group leader exited before its children.
      this.signal(s, 'SIGKILL')
      try {
        await Promise.race([s.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, delay) })])
      } finally { clearTimeout(timer) }
      s.child.stdout.destroy(); s.child.stderr.destroy()
    })()
    return s.cleanup
  }
  async stop(id: string): Promise<FleetStatus> {
    const s = this.sessions.get(id)
    if (!s) throw new Error('fleet_unknown_id')
    await this.terminate(s)
    delete s.status.turn_id
    this.publish(s, s.exited ? 'stopped' : 'unknown', s.exited ? undefined : 'fleet_shutdown_timeout')
    await s.eventQueue
    return { ...s.status }
  }
  async close(): Promise<void> {
    this.closing = true
    await Promise.all([...this.sessions.keys()].map(id => this.stop(id)))
  }
}
