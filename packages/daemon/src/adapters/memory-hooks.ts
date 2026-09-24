import { join } from 'node:path'
import { Manifest, planFileWrite, planJsonHooks, type DriftItem, type FileChange } from './atomic.js'
import type { GatewayEndpoint, Snapshot } from './base.js'
import { OpenCodeAdapter } from './opencode.js'

// Commands receive event JSON on stdin. No allow/deny decisions, credentials or prompt contents are emitted.
function shellWord(value: string): string {
  if (process.platform === 'win32') {
    if (/["\r\n%]/.test(value)) throw new Error('La ruta del hook contiene caracteres no admitidos por cmd.exe')
    return `"${value}"`
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`
}
export function planMemoryHooks(snapshot: Snapshot, endpoint: GatewayEndpoint, home: string): [FileChange[], DriftItem[]] {
  const kind = snapshot.cli_kind
  if (endpoint.transport !== 'stdio' || !endpoint.args.includes('gateway')) return [[], []]
  const args = endpoint.args.map(a => a === 'gateway' ? 'memory-hook' : a)
  if (!args.includes('--state-dir')) return [[], []]
  args.push('--agenthub-memory-hook')
  const command = `${process.platform === 'win32' ? 'set "ELECTRON_RUN_AS_NODE=1" && ' : 'ELECTRON_RUN_AS_NODE=1 '}${[endpoint.command, ...args].map(shellWord).join(' ')}`
  const enabled = snapshot.servers.some(server => server.tools.some(tool => tool.name === 'finish_notes'))
  const manifest = Manifest.load(home)
  if (kind === 'opencode') {
    const content = `// Managed by Agent Hub. Native session events close only this session's notes.\nimport { spawnSync } from 'node:child_process'\nexport const AgentHubMemory = async ({ directory }) => {\n  const emit = event => { if (!${JSON.stringify(enabled)}) return; spawnSync(${JSON.stringify(endpoint.command)}, ${JSON.stringify(args)}, { input: JSON.stringify({ cwd: directory, ...event }), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 2500, windowsHide: true, stdio: ['pipe','ignore','ignore'] }) }\n  return {\n    'tool.execute.before': async (input, output) => { if (input.tool.startsWith('hub_')) emit({ hook_event_name: 'PreToolUse', session_id: input.sessionID, tool_name: input.tool, tool_input: output.args }) },\n    event: async ({ event }) => { if (['session.idle','session.error','session.deleted'].includes(event.type)) emit({ hook_event_name: event.type === 'session.error' ? 'StopFailure' : event.type === 'session.deleted' ? 'SessionEnd' : 'Stop', session_id: event.properties.sessionID ?? event.properties.info?.id }) }\n  }\n}\n`
    const [change, drift] = planFileWrite({ home, path: join(new OpenCodeAdapter().configDir(home), 'plugins', 'agenthub-memory.js'), content, manifest, cliKind: kind, mode: 0o600 })
    return [change ? [change] : [], drift]
  }
  const path = kind === 'codex_cli' ? join(home, '.codex', 'hooks.json') : kind === 'claude_code' ? join(home, '.claude', 'settings.json')
    : kind === 'gemini_cli' ? join(home, '.gemini', 'settings.json') : null
  if (!path) return [[], []]
  const before = kind === 'gemini_cli' ? 'BeforeTool' : 'PreToolUse'
  const stop = kind === 'gemini_cli' ? 'AfterAgent' : 'Stop'
  const hooks: Record<string, unknown[]> = enabled ? {
    [before]: [{ matcher: '.*hub.*', hooks: [{ type: 'command', command, timeout: kind === 'gemini_cli' ? 2500 : 3 }] }],
    [stop]: [{ hooks: [{ type: 'command', command, timeout: kind === 'gemini_cli' ? 2500 : 3 }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command, timeout: kind === 'gemini_cli' ? 2500 : 3 }] }],
    ...(kind === 'codex_cli' ? { Interrupt: [{ hooks: [{ type: 'command', command, timeout: 3 }] }] } : {}),
    ...(kind === 'claude_code' ? { StopFailure: [{ hooks: [{ type: 'command', command, timeout: 3 }] }] } : {}),
  } : {}
  const [change, drift] = planJsonHooks({ home, path, keyPath: ['hooks'], value: hooks, manifest, cliKind: kind })
  return [change ? [change] : [], drift]
}
