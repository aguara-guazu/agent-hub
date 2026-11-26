import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { childEnv, killTree } from '@agenthub/gateway/platform'
import { Ajv } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { cliLabels, findExtractionCli, validCliModel, type ExtractionCli } from '../cli-extraction.js'
import { check, MemoryError } from '../contracts.js'
import { isKiroV3Session, kiroConfigOption } from '../kiro-v3.js'
import { findOpenCode } from '../opencode.js'
import { reasoningEffortSchema } from '../reasoning.js'

export interface AssistantTerminalInput {
  provider: ExtractionCli | 'opencode'
  model: string
  effort: string
  cwd: string
  prompt: string
  schema: Record<string, unknown>
  sessionId?: string
  signal: AbortSignal
  env?: Record<string, string>
  /** Exact Hub tool names verified against the effective client snapshot for this turn. */
  readTools?: string[]
}
export interface AssistantTerminalResult {
  value: unknown
  sessionId?: string
  inputTokens: number
  outputTokens: number
}
const labels = { ...cliLabels, opencode: 'OpenCode' }
const sessionPattern = /^[a-zA-Z0-9][\w-]{0,127}$/
interface TeamBridge { command: string; args: string[] }
const bridgeEnv = { ELECTRON_RUN_AS_NODE: '1' }

async function invocation(input: AssistantTerminalInput, env: Record<string, string>, team?: TeamBridge) {
  const { provider, model, effort, schema, sessionId } = input
  const args: string[] = []
  let structured = false
  switch (provider) {
    case 'claude_code': {
      const allowed = (input.readTools ?? []).filter(name => /^[a-zA-Z0-9_-]{1,128}$/.test(name)).map(name => 'mcp__hub__' + name)
      if (team) {
        const config = { mcpServers: { resident_team: { type: 'stdio', ...team, env: bridgeEnv } } }
        args.push('--mcp-config', JSON.stringify(config))
        allowed.push('mcp__resident_team__team')
      }
      args.push('--print', '--output-format', 'stream-json', '--verbose', '--model', model)
      if (allowed.length) args.push('--allowedTools', allowed.join(','))
      // Claude's CLI accepts draft-07. Zod's default declaration is 2020-12 even for schemas entirely in the shared subset.
      const nativeSchema = { ...schema }
      if (nativeSchema.$schema === 'https://json-schema.org/draft/2020-12/schema') delete nativeSchema.$schema
      try {
        new Ajv({ strict: false, strictSchema: true, validateFormats: false }).compile(nativeSchema)
        args.push('--json-schema', JSON.stringify(nativeSchema))
        structured = true
      } catch { /* Other dialect features use the prompt and full local validation. */ }
      if (effort) args.push('--effort', effort)
      if (sessionId) args.push('--resume', sessionId)
      break
    }
    case 'codex_cli':
      args.push('exec')
      if (sessionId) args.push('resume')
      args.push('--skip-git-repo-check', '--json', '--model', model)
      if (effort) args.push('-c', 'model_reasoning_effort=' + JSON.stringify(effort))
      if (team) args.push('-c', 'mcp_servers.resident_team.command=' + JSON.stringify(team.command),
        '-c', 'mcp_servers.resident_team.args=' + JSON.stringify(team.args),
        '-c', 'mcp_servers.resident_team.tools.team.approval_mode="approve"',
        '-c', 'mcp_servers.resident_team.env.ELECTRON_RUN_AS_NODE="1"')
      if (sessionId) args.push(sessionId)
      args.push('-')
      break
    case 'kiro':
      if (team) {
        // The settings catalog uses Kiro's v2 harness. A session originally opened on v3 must resume on that harness.
        if (isKiroV3Session(sessionId)) args.push('acp', '--agent-engine', 'v3')
        else {
          args.push('acp', '--agent-engine', 'v2', '--model', model, '--trust-tools', '@resident_team/team')
          if (effort) args.push('--effort', effort)
        }
        break
      }
      args.push('chat', '--no-interactive', '--output-format', 'stream-json', '--model', model)
      if (effort) args.push('--effort', effort)
      if (sessionId) args.push('--resume-id', sessionId)
      break
    case 'opencode':
      args.push('run', '--dir', input.cwd, '--format', 'json', '--model', model)
      if (effort) args.push('--variant', effort)
      if (sessionId) args.push('--session', sessionId)
      if (team) {
        const server = { type: 'local', command: [team.command, ...team.args], environment: bridgeEnv }
        try {
          const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}')
          env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, mcp: { ...config.mcp, resident_team: server } })
        } catch {
          // OpenCode can also read inline JSONC and expand file references. Let it parse those itself and add a separate layer.
          const dir = dirname(team.args.at(-1)!), path = join(dir, 'opencode.json')
          if (!env.OPENCODE_CONFIG) env.OPENCODE_CONFIG = path
          else if (!env.OPENCODE_CONFIG_DIR) env.OPENCODE_CONFIG_DIR = dir
          else throw new MemoryError(409, 'OpenCode necesita una configuración inline JSON para agregar el equipo a estos directorios personalizados.')
          await writeFile(path, JSON.stringify({ mcp: { resident_team: server } }), { mode: 0o600 })
        }
      }
      break
  }
  // Codex's strict --output-schema cannot express optional object fields used by the assistant. Validate the final response locally.
  const prompt = structured ? input.prompt : input.prompt + '\n\nAl terminar, devolvé la respuesta final en JSON con este esquema:\n' + JSON.stringify(schema)
  return { args, prompt }
}

const tokens = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0
// A missing rollout is recoverable only at startup. Once tools may have run, replaying the prompt can duplicate effects.
const missingSession = /no rollout found for thread id|no conversation found with session id|\b(?:session|conversation|thread)(?: id)?(?: [\w-]+)? (?:was )?not found\b|\bno saved (?:chat )?session (?:found|with)/i

function answerFromText(text: string, schema: Record<string, unknown>): unknown {
  const trimmed = text.trim()
  const fenced = [...trimmed.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/gi)].at(-1)
  try { return JSON.parse(fenced?.[1] ?? trimmed) } catch {
    // Some models answer conversational turns in prose after using tools. Only the caller's chat schema can accept this form.
    if (trimmed && !fenced && !['[', '{', '`'].includes(trimmed[0]!) && schema.type === 'object' &&
      Array.isArray(schema.required) && schema.required.length === 1 && schema.required[0] === 'reply') return { reply: trimmed }
    throw new MemoryError(502, 'La terminal del asistente devolvió una respuesta que no se pudo leer como JSON.')
  }
}

/** Native, persistent sessions in the caller's workspace, with the CLI's own skills, MCP servers and permission policy. */
export async function runAssistantTerminal(input: AssistantTerminalInput): Promise<AssistantTerminalResult> {
  input.signal.throwIfAborted()
  const { AGENTHUB_RESIDENT_TEAM_NODE: node, AGENTHUB_RESIDENT_TEAM_CLI: bridge,
    AGENTHUB_RESIDENT_TEAM_URL: url, AGENTHUB_RESIDENT_TEAM_TOKEN: token } = input.env ?? {}
  if (!node && !bridge && !url && !token) return run(input)
  check(node && bridge && url && token && isAbsolute(node) && isAbsolute(bridge), 'Falta la autorización del equipo para este turno.', 409)
  // Most clients pass their full environment to unrelated MCP servers. Only the team's bridge receives the credential file.
  const dir = await mkdtemp(join(tmpdir(), 'agenthub-resident-'))
  try {
    const path = join(dir, 'grant.json')
    await writeFile(path, JSON.stringify({ AGENTHUB_RESIDENT_TEAM_URL: url, AGENTHUB_RESIDENT_TEAM_TOKEN: token }), { mode: 0o600, flag: 'wx' })
    return await run(input, { command: node!, args: [bridge!, '--mcp', '--grant-file', path] })
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

async function run(input: AssistantTerminalInput, team?: TeamBridge): Promise<AssistantTerminalResult> {
  const { provider, model, effort, cwd, schema, sessionId, signal } = input
  signal.throwIfAborted()
  check(validCliModel(model) && reasoningEffortSchema.safeParse(effort).success && !effort.startsWith('-'), 'Revisá el modelo y el esfuerzo en Ajustes.', 409)
  check(isAbsolute(cwd) && (!sessionId || sessionPattern.test(sessionId)), 'Directorio o sesión del asistente inválidos.', 400)
  const env = childEnv(input.env, { PWD: cwd, NO_COLOR: '1', CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined,
    CODEX_THREAD_ID: undefined, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
    ...(provider === 'claude_code' && effort ? { CLAUDE_CODE_EFFORT_LEVEL: undefined } : {}),
    ...(provider === 'kiro' ? {} : { KIRO_API_KEY: undefined }) })
  for (const key of Object.keys(env)) if (/^(AGENTHUB_|ORCA_)/i.test(key)) delete env[key]
  const executable = provider === 'opencode' ? findOpenCode(env) : findExtractionCli(provider, env)
  check(executable, `No se encontró ${labels[provider]}. Revisá la instalación de la CLI.`, 409)
  const { args, prompt } = await invocation(input, env, team)
  const acp = provider === 'kiro' && team
  signal.throwIfAborted()
  const Validator = schema.$schema === 'http://json-schema.org/draft-07/schema#' ? Ajv : Ajv2020
  const validate = new Validator({ strict: false, validateFormats: false }).compile(schema)
  const deadline = AbortSignal.timeout(600_000)
  const lifetime = AbortSignal.any([signal, deadline])
  // cli-host keeps a separate process group and tears it down on EOF even if the worker exits unexpectedly.
  const host = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../cli-host.ts' : '../cli-host.js', import.meta.url))
  const child = spawn(process.execPath, [host, executable!, ...args], {
    cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1', AGENTHUB_RESIDENT_TURN: '1' }, stdio: 'pipe', windowsHide: true,
  })
  let id: string | undefined, value: unknown, text = '', inputTokens = 0, outputTokens = 0
  let completed = false, started = false, failed = false, diagnostic = '', pending = ''
  let problem: unknown, hardStop: NodeJS.Timeout | undefined
  let linger: NodeJS.Timeout | undefined, closingAfterResult = false
  function terminate() {
    if (hardStop) return
    if (process.platform === 'win32') { killTree(child); return }
    child.stdin.end()
    child.kill('SIGTERM')
    hardStop = setTimeout(() => child.kill('SIGKILL'), 2500)
    hardStop.unref()
  }
  function stop(error: unknown) {
    if (problem) return
    problem = error
    terminate()
  }
  function finish() {
    if (linger) return
    // Native clients normally exit after persisting the turn. A long-lived MCP or hook may otherwise hold their pipes indefinitely.
    linger = setTimeout(() => { closingAfterResult = true; terminate() }, 750)
    linger.unref()
  }
  const abort = () => stop(signal.aborted ? signal.reason : new MemoryError(503, `${labels[provider]} no respondió a tiempo.`, true))
  const session = (observed: unknown) => {
    if (observed === undefined || observed === null) return
    check(typeof observed === 'string' && sessionPattern.test(observed) && !(id && id !== observed) && !(sessionId && sessionId !== observed),
      'La CLI devolvió una sesión distinta de la solicitada.', 502)
    id = observed as string
  }
  const send = (data: unknown) => child.stdin.write(JSON.stringify({ stdin: JSON.stringify(data) + '\n' }) + '\n')
  const rpc = (id: number, method: string, params: unknown) => send({ jsonrpc: '2.0', id, method, params })
  function acpEvent(e: any, bridge: TeamBridge) {
    if (e.id !== undefined && e.method) {
      if (e.method !== 'session/request_permission') {
        send({ jsonrpc: '2.0', id: e.id, error: { code: -32601, message: 'Unsupported client request' } })
        return
      }
      // Kiro resolves the MCP identity. Titles, annotations and tool inputs are not evidence of the grant.
      const meta = e.params?._meta, envelope = meta?.kiro?.mcpTool
      const identity = envelope?.version === 1 ? envelope.identity : !isKiroV3Session(id) ? meta?.mcpToolIdentity : undefined
      const authorized = started && id === e.params?.sessionId && identity?.serverName === 'resident_team' && identity.toolName === 'team'
      const option = authorized && Array.isArray(e.params?.options) &&
        e.params.options.find((o: any) => o.kind === 'allow_once' && typeof o.optionId === 'string')
      send({ jsonrpc: '2.0', id: e.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } })
      return
    }
    if (e.method === 'session/update') {
      const update = e.params?.update
      if (!started || !id || e.params.sessionId !== id) return
      if (update?.sessionUpdate === 'tool_call') text = ''
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') text += update.content.text
      return
    }
    if (e.method || typeof e.id !== 'number') return
    if (e.error) { diagnostic = String(e.error.message ?? ''); failed = true; terminate(); return }
    if (e.id === 0) {
      if (sessionId) check(e.result?.agentCapabilities?.loadSession, 'Kiro no admite reanudar esta sesión.', 409)
      rpc(1, sessionId ? 'session/load' : 'session/new', { cwd, ...(sessionId ? { sessionId } : {}),
        mcpServers: [{ name: 'resident_team', ...bridge, env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] }] })
      return
    }
    if (e.id >= 1 && e.id <= 3) {
      if (e.id === 1) { session(e.result?.sessionId ?? sessionId); check(id, 'Kiro no devolvió una sesión.', 502) }
      if (isKiroV3Session(id)) {
        for (const [requestId, key, expected] of [[2, 'model', model], [3, 'effortLevel', effort]] as const) {
          if (!expected) continue
          const option = kiroConfigOption(e.result?.configOptions, key)
          if (option?.currentValue === expected) continue
          check(e.id < requestId && option?.options.some(o => o.value === expected), 'Kiro no ofrece el modelo o esfuerzo elegido.', 409)
          rpc(requestId, 'session/set_config_option', { sessionId: id, configId: key, value: expected })
          return
        }
      }
      started = true
      rpc(4, 'session/prompt', { sessionId: id, prompt: [{ type: 'text', text: prompt }] })
    } else if (e.id === 4) {
      completed = e.result?.stopReason === 'end_turn'
      if (e.result?.usage) { inputTokens = tokens(e.result.usage.inputTokens); outputTokens = tokens(e.result.usage.outputTokens) }
      terminate()
    }
  }
  function event(line: string) {
    if (!line.trim()) return
    let e: any
    try { e = JSON.parse(stripVTControlCharacters(line)) } catch { return } // Startup notices, hooks and progress can share stdout.
    if (acp && e?.jsonrpc === '2.0') { acpEvent(e, acp); return }
    if (!e || typeof e.type !== 'string') return
    if (provider === 'claude_code') {
      if (e.type === 'assistant' || e.type === 'user') started = true
      if (e.type !== 'result') return
      finish()
      if (e.is_error || e.subtype !== 'success') { failed = true; diagnostic += '\n' + [e.subtype, e.result, e.errors].join('\n'); return }
      session(e.session_id)
      completed = true
      value = e.structured_output
      text = typeof e.result === 'string' ? e.result : ''
      inputTokens = tokens(e.usage?.input_tokens) + tokens(e.usage?.cache_read_input_tokens) + tokens(e.usage?.cache_creation_input_tokens)
      outputTokens = tokens(e.usage?.output_tokens)
    } else if (provider === 'codex_cli') {
      if (e.type === 'thread.started') session(e.thread_id)
      if (e.type === 'turn.started' || e.type === 'item.started' || e.type === 'item.completed') started = true
      if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') text = e.item.text
      if (e.type === 'turn.completed') { completed = true; inputTokens = tokens(e.usage?.input_tokens); outputTokens = tokens(e.usage?.output_tokens); finish() }
      // A retryable stream error can be followed by a successful turn.
      if (e.type === 'turn.failed') { failed = true; diagnostic += '\n' + String(e.error?.message ?? ''); finish() }
      if (e.type === 'error') diagnostic += '\n' + String(e.message ?? '')
    } else if (provider === 'kiro') {
      if (e.type === 'runError') { failed = true; diagnostic += '\n' + String(e.data?.message ?? ''); finish(); return }
      if (e.type === 'runStarted' || e.type === 'sessionUpdate' || e.type === 'toolCall') started = true
      session(e.data?.sessionId)
      if (e.type !== 'runFinished') return
      finish()
      completed = e.data?.status === 'success' && e.data.stopReason === 'end_turn' && !e.data.finalTextTruncated
      text = typeof e.data?.finalText === 'string' ? e.data.finalText : ''
    } else {
      session(e.sessionID)
      if (e.type === 'error') { failed = true; diagnostic += '\n' + String(e.error?.data?.message ?? ''); finish(); return }
      if (e.type === 'step_start' || e.type === 'tool_use' || e.type === 'text') started = true
      if (e.type === 'step_start') { text = ''; completed = false }
      if (e.type === 'text' && typeof e.part?.text === 'string') text += e.part.text
      if (e.type !== 'step_finish') return
      inputTokens += tokens(e.part?.tokens?.input) + tokens(e.part?.tokens?.cache?.read) + tokens(e.part?.tokens?.cache?.write)
      outputTokens += tokens(e.part?.tokens?.output)
      completed = e.part?.reason === 'stop'
      if (completed) finish()
    }
  }
  const label = labels[provider]
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (problem) return
        pending += chunk
        try {
          const lines = pending.split('\n')
          pending = lines.pop()!
          for (const line of lines) event(line)
          check(pending.length < 8_000_000 && text.length < 8_000_000, 'La terminal del asistente excedió el límite de salida.', 502)
          diagnostic = diagnostic.slice(-8192)
        } catch (e) { stop(e) }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => { diagnostic = (diagnostic + chunk).slice(-8192) })
      child.stdin.on('error', () => undefined)
      child.once('error', () => reject(new MemoryError(502, `No se pudo iniciar ${label}.`)))
      child.once('close', resolve)
      lifetime.addEventListener('abort', abort, { once: true })
      if (lifetime.aborted) abort()
      else if (acp) rpc(0, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agenthub-resident', version: '1' } })
      else child.stdin.write(JSON.stringify({ stdin: prompt, end: true }) + '\n')
    })
    if (problem) throw problem
    event(pending)
    if ((code !== 0 && !acp && !closingAfterResult) || failed || !completed) {
      const detail = stripVTControlCharacters(diagnostic)
      if (sessionId && !started && missingSession.test(detail))
        throw new MemoryError(404, `${label} ya no tiene guardada la sesión del asistente.`, false, 'assistant_session_missing')
      if (/not a valid JSON Schema|invalid .*schema|no schema with key or ref|invalid_json_schema/i.test(detail))
        throw new MemoryError(502, `${label} rechazó el esquema de respuesta del asistente.`, false, 'assistant_cli_schema')
      if (/invalid api key|authentication_error|not logged in|login required|please (?:run .*login|sign in)|unauthorized|oauth token .*expir/i.test(detail))
        throw new MemoryError(409, `${label} necesita que vuelvas a autenticar la cuenta de la terminal.`, false, 'assistant_cli_auth')
      if (/rate.limit|quota exceeded|usage limit|insufficient_quota|out of .*credits/i.test(detail))
        throw new MemoryError(503, `${label} agotó la cuota disponible para este turno.`, true, 'assistant_cli_quota')
      if (/model_not_found|unknown model|model .* (?:not found|does not exist|not available)|unsupported .*effort/i.test(detail))
        throw new MemoryError(409, `${label} rechazó el modelo o esfuerzo elegido en Ajustes de Memoria.`, false, 'assistant_cli_model')
      throw new MemoryError(502, `${label} no completó el turno${code === null ? '' : ' (código ' + code + ')'}. Revisá la sesión, el modelo y los permisos de la terminal.`)
    }
    if (value === undefined) value = answerFromText(text, schema)
    check(validate(value), `La respuesta de ${label} no cumple el esquema solicitado por el asistente.`, 502)
    return { value, ...(id || sessionId ? { sessionId: id ?? sessionId! } : {}), inputTokens, outputTokens }
  } finally {
    lifetime.removeEventListener('abort', abort)
    clearTimeout(linger)
    clearTimeout(hardStop)
  }
}
