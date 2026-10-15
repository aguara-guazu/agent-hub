import { join } from 'node:path'
import { driftItem, Manifest, planFileWrite, planJsonHooks, planJsonValue, type DriftItem, type FileChange } from './atomic.js'
import type { GatewayEndpoint, Snapshot } from './base.js'
import { OpenCodeAdapter } from './opencode.js'

const WINDOWS = process.platform === 'win32'

// Commands receive event JSON on stdin. No allow/deny decisions, credentials or prompt contents are emitted.
function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/**
 * Literal de PowerShell entre comillas simples: sólo `'` y las comillas tipográficas que PowerShell también toma como
 * delimitador se escapan, duplicándolas. Windows PowerShell 5.1 no escapa `"` al pasar argumentos a un ejecutable
 * nativo y un salto de línea parte el comando: esas rutas no tienen representación segura.
 */
function powershellWord(value: string): string {
  if (/["\0\r\n]/.test(value)) throw new Error('La ruta del hook contiene caracteres que PowerShell no pasa intactos al ejecutable')
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`
}

/**
 * En Windows Claude Code (`shell: 'powershell'`) y Gemini CLI corren el hook con PowerShell, que puede ser 5.1: sin
 * `&&`, con `;`. Codex no documenta su shell en Windows: `-EncodedCommand` reduce el script a un token base64 de
 * UTF-16LE sin espacios ni comillas que cmd.exe, Git Bash y PowerShell pasan tal cual.
 */
function hookCommand(command: string, args: string[], encoded: boolean): string {
  if (!WINDOWS) return `ELECTRON_RUN_AS_NODE=1 ${[command, ...args].map(shellWord).join(' ')}`
  const script = `$env:ELECTRON_RUN_AS_NODE='1'; & ${[command, ...args].map(powershellWord).join(' ')}`
  if (!encoded) return script
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}

export function planMemoryHooks(snapshot: Snapshot, endpoint: GatewayEndpoint, home: string): [FileChange[], DriftItem[]] {
  const kind = snapshot.cli_kind
  if (endpoint.transport !== 'stdio' || !endpoint.args.includes('gateway')) return [[], []]
  const args = endpoint.args.map(a => a === 'gateway' ? 'memory-hook' : a)
  if (!args.includes('--state-dir')) return [[], []]
  args.push('--agenthub-memory-hook')
  const enabled = snapshot.servers.some(server => server.tools.some(tool => tool.name === 'finish_notes'))
  const manifest = Manifest.load(home)
  if (kind === 'antigravity') {
    const path = join(home, '.gemini/config/hooks.json')
    try {
      // Antigravity uses named definitions, flat Stop handlers and camelCase payloads.
      // Its payload has no event name, so each command carries the event explicitly.
      const handler = (event: string) => ({ type: 'command',
        command: hookCommand(endpoint.command, [...args, '--hook-event', event], true), timeout: WINDOWS ? 10 : 3 })
      const value = enabled ? {
        PreToolUse: [{ matcher: '^mcp_hub_.*', hooks: [handler('PreToolUse')] }],
        Stop: [handler('Stop')],
      } : { enabled: false }
      const [change, drift] = planJsonValue({ home, path, keyPath: ['agenthub-memory'], value, manifest, cliKind: kind,
        summary: 'Eventos de conversación de Antigravity para la memoria' })
      return [change ? [change] : [], drift]
    } catch (error) { return [[], [driftItem(path, 'agenthub-memory', (error as Error).message)]] }
  }
  if (kind === 'opencode') {
    const content = `// Managed by Agent Hub. Native session events close only this session's notes.\nimport { spawnSync } from 'node:child_process'\nexport const AgentHubMemory = async ({ directory }) => {\n  const emit = event => { if (!${JSON.stringify(enabled)}) return; spawnSync(${JSON.stringify(endpoint.command)}, ${JSON.stringify(args)}, { input: JSON.stringify({ cwd: directory, ...event }), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 2500, windowsHide: true, stdio: ['pipe','ignore','ignore'] }) }\n  return {\n    'tool.execute.before': async (input, output) => { if (input.tool.startsWith('hub_')) emit({ hook_event_name: 'PreToolUse', session_id: input.sessionID, tool_name: input.tool, tool_input: output.args }) },\n    event: async ({ event }) => { if (['session.idle','session.error','session.deleted'].includes(event.type)) emit({ hook_event_name: event.type === 'session.error' ? 'StopFailure' : event.type === 'session.deleted' ? 'SessionEnd' : 'Stop', session_id: event.properties.sessionID ?? event.properties.info?.id }) }\n  }\n}\n`
    const [change, drift] = planFileWrite({ home, path: join(new OpenCodeAdapter().configDir(home), 'plugins', 'agenthub-memory.js'), content, manifest, cliKind: kind, mode: 0o600 })
    return [change ? [change] : [], drift]
  }
  const path = kind === 'codex_cli' ? join(home, '.codex', 'hooks.json') : kind === 'claude_code' ? join(home, '.claude', 'settings.json')
    : kind === 'gemini_cli' ? join(home, '.gemini', 'settings.json') : null
  if (!path) return [[], []]
  let command = ''
  try {
    if (enabled) command = hookCommand(endpoint.command, args, kind === 'codex_cli')
  } catch (error) {
    return [[], [driftItem(path, 'hooks', (error as Error).message)]]
  }
  const handler = (timeout: number) => kind === 'codex_cli' && WINDOWS ? { type: 'command', command, commandWindows: command, timeout }
    : { type: 'command', command, timeout, ...(kind === 'claude_code' && WINDOWS ? { shell: 'powershell' } : {}) }
  // Gemini mide en milisegundos y el resto en segundos. Arrancar PowerShell y Electron como Node tarda más en Windows;
  // Codex limita SessionEnd e Interrupt a 3 s.
  const timeout = kind === 'gemini_cli' ? (WINDOWS ? 10_000 : 2500) : WINDOWS ? 10 : 3
  const before = kind === 'gemini_cli' ? 'BeforeTool' : 'PreToolUse'
  const stop = kind === 'gemini_cli' ? 'AfterAgent' : 'Stop'
  const hooks: Record<string, unknown[]> = enabled ? {
    [before]: [{ matcher: '.*hub.*', hooks: [handler(timeout)] }],
    [stop]: [{ hooks: [handler(timeout)] }],
    SessionEnd: [{ hooks: [handler(kind === 'codex_cli' ? 3 : timeout)] }],
    ...(kind === 'codex_cli' ? { Interrupt: [{ hooks: [handler(3)] }] } : {}),
    ...(kind === 'claude_code' ? { StopFailure: [{ hooks: [handler(timeout)] }] } : {}),
  } : {}
  const [change, drift] = planJsonHooks({ home, path, keyPath: ['hooks'], value: hooks, manifest, cliKind: kind })
  return [change ? [change] : [], drift]
}
