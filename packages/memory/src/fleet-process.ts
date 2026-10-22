import { spawn, execFile, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

export type FleetState = 'starting' | 'busy' | 'idle' | 'stopped' | 'failed' | 'unknown' | 'waiting_input'
export interface FleetStart {
  id: string
  cli: 'claude_code' | 'codex_cli'
  cwd: string
  model: string
  effort?: string
  prompt: string
  resume_id?: string
}
/** No prompts, transcripts, command output or CLI error text. Native questions are explicitly structured. */
export interface FleetQuestion {
  id: string
  header: string
  question: string
  options?: Array<{ label: string; description: string }> | null
  isOther?: boolean
  isSecret?: boolean
}
export interface FleetPendingQuestion { id: string; questions: FleetQuestion[] }
export type FleetQuestionAnswers = Record<string, { answers: string[] }>
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
  questions?: FleetPendingQuestion[]
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
type PendingQuestion = {
  value: FleetPendingQuestion
  rpcId: string | number
  turnId: string
  blocking: boolean
  answering: boolean
  claudeInput?: Packet
}
type Session = {
  status: FleetStatus
  child: ChildProcessWithoutNullStreams
  closed: Promise<void>
  exited: boolean
  stopping: boolean
  seq: number
  pending: Map<number, Pending>
  questions: Map<string, PendingQuestion>
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
    return value ? this.snapshot(value) : undefined
  }
  list(): FleetStatus[] { return [...this.sessions.values()].map(s => this.snapshot(s.status)) }

  private snapshot(value: FleetStatus): FleetStatus {
    return { ...value, ...(value.questions ? { questions: structuredClone(value.questions) } : {}) }
  }
  private publish(s: Session, state: FleetState, error_code?: string) {
    if (this.sessions.get(s.status.id) !== s) return
    s.status.state = state
    if (error_code) s.status.error_code = error_code
    else delete s.status.error_code
    const event = this.snapshot(s.status)
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
    this.clearQuestions(s)
    this.publish(s, 'failed', code)
    this.rejectPending(s, code)
    void this.terminate(s)
  }
  private receive(s: Session, packet: Packet) {
    if (!this.live(s)) return
    if (s.status.cli === 'claude_code') {
      if (packet.type === 'control_request' && packet.request?.subtype === 'can_use_tool') {
        if (packet.request.tool_name === 'AskUserQuestion') this.registerQuestions(s, packet, true)
        else this.write(s, { type: 'control_response', response: { subtype: 'success', request_id: packet.request_id,
          response: { behavior: 'deny', message: 'Unsupported interactive fleet request' } } })
        return
      }
      if (packet.type === 'control_cancel_request') { this.cancelQuestion(s, packet.request_id); return }
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
        if (!['busy', 'waiting_input'].includes(s.status.state)) return
        this.clearQuestions(s)
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
      if (packet.method === 'item/tool/requestUserInput') { this.registerQuestions(s, packet, false); return }
      // Never grant unexpected server requests, even in a fully authorized child.
      this.write(s, { id: packet.id, error: { code: -32601, message: 'Unsupported fleet client request' } })
      this.fail(s, 'fleet_unexpected_server_request')
      return
    }
    const params = packet.params ?? {}
    if (params.threadId !== s.status.native_id || !s.status.native_id) return
    if (packet.method === 'serverRequest/resolved') { this.cancelQuestion(s, params.requestId); return }
    if (packet.method === 'turn/started' && typeof params.turn?.id === 'string') {
      if (s.completedTurns.has(params.turn.id)) return
      if (!s.submitting && s.status.turn_id !== params.turn.id) return
      s.status.turn_id = params.turn.id
      this.refreshQuestions(s)
    }
    if (packet.method === 'turn/completed' && params.turn?.id === s.status.turn_id) {
      const turn = params.turn
      s.completedTurns.add(turn.id)
      if (s.completedTurns.size > 256) s.completedTurns.delete(s.completedTurns.values().next().value!)
      this.clearQuestions(s)
      delete s.status.turn_id
      if (turn.status === 'completed' || turn.status === 'interrupted') this.publish(s, 'idle')
      else this.fail(s, turn.status === 'failed' ? 'fleet_turn_failed' : 'fleet_invalid_turn_status')
    }
    if (packet.method === 'error' && params.willRetry === false) this.fail(s, 'fleet_turn_failed')
  }

  private clearQuestions(s: Session) {
    s.questions.clear()
    s.status.questions = []
  }
  private refreshQuestions(s: Session) {
    s.status.questions = [...s.questions.values()].map(p => structuredClone(p.value))
    this.publish(s, [...s.questions.values()].some(p => p.blocking) ? 'waiting_input' : 'busy')
  }
  private cancelQuestion(s: Session, rpcId: unknown) {
    let changed = false
    for (const [id, question] of s.questions) if (question.rpcId === rpcId) { s.questions.delete(id); changed = true }
    if (changed) this.refreshQuestions(s)
  }
  private registerQuestions(s: Session, packet: Packet, claude: boolean) {
    const raw = claude ? packet.request?.input?.questions : packet.params?.questions
    const rpcId: unknown = claude ? packet.request_id : packet.id
    const turnId = claude ? s.status.turn_id : packet.params?.turnId
    const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
    const reject = () => this.write(s, claude
      ? { type: 'control_response', response: { subtype: 'error', request_id: rpcId, error: 'Invalid fleet question request' } }
      : { id: rpcId, error: { code: -32602, message: 'Invalid fleet question request' } })
    if ((!text(rpcId, 512) && !(typeof rpcId === 'number' && Number.isSafeInteger(rpcId))) || !text(turnId, 512) ||
      !s.status.native_id || (!claude && packet.params?.threadId !== s.status.native_id) ||
      (turnId !== s.status.turn_id && !(s.submitting && !s.status.turn_id)) ||
      !Array.isArray(raw) || raw.length < 1 || raw.length > 8 || s.questions.size >= 32) { reject(); return }
    if ([...s.questions.values()].some(p => p.rpcId === rpcId)) return
    const questions: FleetQuestion[] = []
    for (const [index, item] of raw.entries()) {
      const id = claude ? `q${index + 1}` : item?.id
      if (!text(id, 200) || ['__proto__', 'constructor', 'prototype'].includes(id) || !text(item?.header, 200) || !text(item?.question, 6000) ||
        (item.options != null && (!Array.isArray(item.options) || item.options.length > 20 || item.options.some((o: Packet) => !text(o?.label, 300) || typeof o?.description !== 'string' || o.description.length > 2000)))) { reject(); return }
      questions.push({ id, header: item.header, question: item.question,
        options: item.options == null ? null : item.options.map((o: Packet) => ({ label: o.label, description: o.description })),
        isOther: claude ? true : item.isOther === true, isSecret: !claude && item.isSecret === true })
    }
    if (new Set(questions.map(q => q.id)).size !== questions.length || (claude && new Set(questions.map(q => q.question)).size !== questions.length)) { reject(); return }
    const value = { id: randomUUID(), questions }
    const pending: PendingQuestion = { value, rpcId: rpcId as string | number, turnId, blocking: claude || packet.params?.isBlocking !== false, answering: false }
    if (claude) pending.claudeInput = { questions: raw.map((q: Packet, i: number) => ({ question: q.question, header: q.header,
      options: questions[i]!.options ?? [], multiSelect: q.multiSelect === true })) }
    s.questions.set(value.id, pending)
    s.status.turn_id = turnId
    this.refreshQuestions(s)
  }
  async answer(id: string, questionId: string, answers: FleetQuestionAnswers): Promise<FleetStatus> {
    const s = this.sessions.get(id)
    if (!s || !this.live(s)) throw new Error('fleet_process_unavailable')
    const pending = s.questions.get(questionId)
    if (!pending || pending.turnId !== s.status.turn_id || pending.answering) throw new Error('fleet_question_unavailable')
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== pending.value.questions.length) throw new Error('fleet_invalid_answers')
    const response: FleetQuestionAnswers = Object.create(null)
    for (const q of pending.value.questions) {
      const value = Object.hasOwn(answers, q.id) ? answers[q.id] : undefined
      if (!Array.isArray(value?.answers) || value.answers.length < 1 || value.answers.length > 20 || value.answers.some(a => typeof a !== 'string' || !a.length || a.length > 10_000 || a.includes('\0'))) throw new Error('fleet_invalid_answers')
      response[q.id] = { answers: [...value.answers] }
    }
    const packet = s.status.cli === 'codex_cli' ? { id: pending.rpcId, result: { answers: response } }
      : { type: 'control_response', response: { subtype: 'success', request_id: pending.rpcId, response: { behavior: 'allow',
        updatedInput: { ...pending.claudeInput, answers: Object.fromEntries(pending.value.questions.map(q => [q.question, response[q.id]!.answers.join(', ')])) } } } }
    pending.answering = true
    try {
      await new Promise<void>((resolve, reject) => {
        if (!this.live(s) || !s.child.stdin.writable) { reject(new Error('fleet_process_unavailable')); return }
        s.child.stdin.write(JSON.stringify(packet) + '\n', error => error ? reject(new Error('fleet_answer_unconfirmed')) : resolve())
      })
    } catch { pending.answering = false; throw new Error('fleet_answer_unconfirmed') }
    if (this.live(s) && s.questions.get(questionId) === pending) { s.questions.delete(questionId); this.refreshQuestions(s) }
    await s.eventQueue
    return this.snapshot(s.status)
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
      if (!old.exited) throw new Error('fleet_previous_process_unconfirmed')
      if (this.closing) throw new Error('fleet_manager_closed')
    }
    const expectedNative = input.cli === 'claude_code' ? input.resume_id ?? randomUUID() : input.resume_id
    const args = input.cli === 'claude_code'
      ? ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool=stdio', '--model', input.model,
        ...(input.effort ? ['--effort', input.effort] : []), ...(input.resume_id ? ['--resume', input.resume_id] : ['--session-id', expectedNative!])]
      : ['app-server', '--listen', 'stdio://']
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^(AGENTHUB_|ORCA_|ELECTRON_RUN_AS_NODE$|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CODEX_THREAD_ID$)/i.test(key)) delete env[key]
    const launcher = this.options.launcher ?? ((command, argv, options) => spawn(command, argv, { ...options, stdio: 'pipe' }))
    const child = launcher(input.cli === 'claude_code' ? 'claude' : 'codex', args, { cwd: input.cwd, env, detached: process.platform !== 'win32', windowsHide: true })
    const status: FleetStatus = { id: input.id, cli: input.cli, cwd: input.cwd, model: input.model, state: 'starting', ...(input.effort ? { effort: input.effort } : {}) }
    let closed!: () => void
    const s: Session = { status, child, closed: new Promise(resolve => { closed = resolve }), exited: false, stopping: false, seq: 0,
      pending: new Map(), questions: new Map(), expectedNative, ready: undefined, submitting: false, completedTurns: new Set(), eventQueue: Promise.resolve(), cleanup: undefined }
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
    return this.snapshot(s.status)
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
        this.refreshQuestions(s)
        if (response.turn.status === 'failed') this.fail(s, 'fleet_turn_failed')
        else if (['completed', 'interrupted'].includes(response.turn.status)) this.receive(s, { method: 'turn/completed', params: { threadId: s.status.native_id, turn: response.turn } })
      }
    } finally { s.submitting = false }
  }
  supportsMidTurn(id: string): boolean {
    const s = this.sessions.get(id)
    return !!s && this.live(s) && s.status.cli === 'codex_cli'
  }
  /** Append input to the confirmed native turn. Never interrupt, restart or replay after a lost ACK. */
  async enqueue(id: string, text: string): Promise<FleetStatus> {
    const s = this.sessions.get(id)
    if (!s || !this.live(s)) throw new Error('fleet_process_unavailable')
    if (!this.supportsMidTurn(id)) throw new Error('fleet_mid_turn_unsupported')
    if (s.status.state !== 'busy' || !s.status.turn_id || s.submitting) throw new Error('fleet_not_busy')
    if (!text.length || text.length > 24_000 || text.includes('\0')) throw new Error('fleet_invalid_input')
    const turnId = s.status.turn_id
    let result: Packet
    try {
      result = await this.request(s, 'turn/steer', { threadId: s.status.native_id, expectedTurnId: turnId,
        clientUserMessageId: randomUUID(), input: [{ type: 'text', text }] })
    } catch (error) {
      // An explicit rejection is safe to retry after refreshing state. A lost ACK is ambiguous.
      if (error instanceof Error && error.message === 'fleet_rpc_error') throw Object.assign(new Error('fleet_steer_rejected'), { retryable: true })
      throw Object.assign(new Error('fleet_steer_unconfirmed'), { retryable: false })
    }
    if (result.turnId !== turnId) throw Object.assign(new Error('fleet_steer_unconfirmed'), { retryable: false })
    if (this.live(s) && s.status.state === 'busy' && s.status.turn_id === turnId) this.publish(s, 'busy')
    await s.eventQueue
    return this.snapshot(s.status)
  }
  async send(id: string, text: string): Promise<FleetStatus> {
    const s = this.sessions.get(id)
    if (!s || !this.live(s) || s.status.state !== 'idle' || s.submitting) throw new Error('fleet_not_idle')
    try {
      if (s.status.cli === 'codex_cli') await this.submit(s, text)
      else { this.writeClaude(s, text); this.publish(s, 'busy') }
    } catch { this.fail(s, 'fleet_send_failed') }
    await s.eventQueue
    return this.snapshot(s.status)
  }
  async interrupt(id: string): Promise<FleetStatus> {
    const s = this.sessions.get(id)
    if (!s || !this.live(s)) throw new Error('fleet_process_unavailable')
    // A question pauses the same active turn; it remains interruptible until native completion.
    if (s.status.state !== 'busy' && s.status.state !== 'waiting_input') throw new Error('fleet_not_busy')
    try {
      if (s.status.cli === 'codex_cli') {
        if (!s.status.turn_id) throw new Error('fleet_missing_turn_id')
        await this.request(s, 'turn/interrupt', { threadId: s.status.native_id, turnId: s.status.turn_id })
      } else this.write(s, { type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
      // Only a result/completed notification can mark the worker idle.
    } catch { this.fail(s, 'fleet_interrupt_failed') }
    await s.eventQueue
    return this.snapshot(s.status)
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
    this.clearQuestions(s)
    delete s.status.turn_id
    this.publish(s, s.exited ? 'stopped' : 'unknown', s.exited ? undefined : 'fleet_shutdown_timeout')
    await s.eventQueue
    return this.snapshot(s.status)
  }
  async close(): Promise<void> {
    this.closing = true
    await Promise.all([...this.sessions.keys()].map(id => this.stop(id)))
  }
}
