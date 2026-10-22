import { join } from 'node:path'
import { driftItem, Manifest, planFileWrite, planJsonHooks, planJsonValue, type DriftItem, type FileChange } from './atomic.js'
import type { GatewayEndpoint, Snapshot } from './base.js'
import { OpenCodeAdapter } from './opencode.js'
import { openCodeMemoryPlugin } from './opencode-chat.js'

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
export function hookCommand(command: string, args: string[], encoded: boolean): string {
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
  const enabled = snapshot.servers.some(server => server.tools.some(tool => ['finish_notes','chat_join'].includes(tool.name)))
  const chat = snapshot.servers.some(server => server.tools.some(tool => tool.name === 'chat_join'))
  const manifest = Manifest.load(home)
  const launchChanges:FileChange[]=[],launchDrift:DriftItem[]=[]
  if (chat && ['claude_code','codex_cli','gemini_cli','kiro','opencode','antigravity'].includes(kind)) {
    const name=kind==='claude_code'?'claude':kind==='opencode'?'opencode':kind==='codex_cli'?'codex':kind==='gemini_cli'?'gemini':kind==='antigravity'?'agy':'kiro'
    const path=join(home,WINDOWS?'.agenthub/bin':'.local/bin',`agenthub-${name}${WINDOWS?'.ps1':''}`)
    try {
      const launchArgs=endpoint.args.map(a=>a==='gateway'?'chat':a).concat('--')
      const content=WINDOWS
        ? `$env:ELECTRON_RUN_AS_NODE='1'\n& ${[endpoint.command,...launchArgs].map(powershellWord).join(' ')} @args\nexit $LASTEXITCODE\n`
        : `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${[endpoint.command,...launchArgs].map(shellWord).join(' ')} "$@"\n`
      const [change,drift]=planFileWrite({home,path,content,manifest,cliKind:kind,mode:0o700})
      if(change)launchChanges.push(change)
      launchDrift.push(...drift)
    } catch(error) {launchDrift.push(driftItem(path,'launcher',(error as Error).message))}
  }
  const withLauncher=(changes:FileChange[],drift:DriftItem[]):[FileChange[],DriftItem[]]=>[[...launchChanges,...changes],[...launchDrift,...drift]]
  if (kind === 'antigravity') {
    const path = join(home, '.gemini/config/hooks.json')
    try {
      // Antigravity uses named definitions, flat Stop handlers and camelCase payloads.
      // Its payload has no event name, so each command carries the event explicitly.
      const handler = (event: string) => ({ type: 'command',
        command: hookCommand(endpoint.command, [...args, '--hook-event', event], true), timeout: WINDOWS ? 10 : 5 })
      const value = enabled ? {
        PreToolUse: [{ matcher: '^mcp_hub_.*', hooks: [handler('PreToolUse')] }],
        Stop: [handler('Stop')],
        ...(chat ? {SessionStart:[handler('SessionStart')],PreInvocation:[handler('PreInvocation')]} : {}),
      } : { enabled: false }
      const [change, drift] = planJsonValue({ home, path, keyPath: ['agenthub-memory'], value, manifest, cliKind: kind,
        summary: 'Eventos de conversación de Antigravity para la memoria' })
      return withLauncher(change ? [change] : [], drift)
    } catch (error) { return withLauncher([], [driftItem(path, 'agenthub-memory', (error as Error).message)]) }
  }
  if (kind === 'opencode') {
    const content = openCodeMemoryPlugin(endpoint.command,args,enabled,chat)
    const [change, drift] = planFileWrite({ home, path: join(new OpenCodeAdapter().configDir(home), 'plugins', 'agenthub-memory.js'), content, manifest, cliKind: kind, mode: 0o600 })
    return withLauncher(change ? [change] : [], drift)
  }
  const path = kind === 'codex_cli' ? join(home, '.codex', 'hooks.json') : kind === 'claude_code' ? join(home, '.claude', 'settings.json')
    : kind === 'gemini_cli' ? join(home, '.gemini', 'settings.json') : null
  if (!path) return withLauncher([], [])
  let command = ''
  try {
    if (enabled) command = hookCommand(endpoint.command, args, kind === 'codex_cli')
  } catch (error) {
    return withLauncher([], [driftItem(path, 'hooks', (error as Error).message)])
  }
  const handler = (timeout: number) => kind === 'codex_cli' && WINDOWS ? { type: 'command', command, commandWindows: command, timeout }
    : { type: 'command', command, timeout, ...(kind === 'claude_code' && WINDOWS ? { shell: 'powershell' } : {}) }
  // Gemini mide en milisegundos y el resto en segundos. Arrancar PowerShell y Electron como Node tarda más en Windows;
  // El presupuesto incluye arranque, inspección acotada del proceso y HTTP (1,8 s).
  // Codex limita SessionEnd e Interrupt a 3 s.
  const timeout = kind === 'gemini_cli' ? (WINDOWS ? 10_000 : 5000) : WINDOWS ? 10 : 5
  const before = kind === 'gemini_cli' ? 'BeforeTool' : 'PreToolUse'
  const stop = kind === 'gemini_cli' ? 'AfterAgent' : 'Stop'
  const hooks: Record<string, unknown[]> = enabled ? {
    [before]: [{ matcher: '.*hub.*', hooks: [handler(timeout)] }],
    [stop]: [{ hooks: [handler(timeout), ...(chat && kind === 'claude_code' ? [{ ...handler(604800), command: hookCommand(endpoint.command,[...args,'--hook-event','Watch'],false), asyncRewake:true }] : [])] }],
    ...(chat ? { SessionStart:[{ hooks:[handler(timeout), ...(kind==='claude_code' ? [{ ...handler(604800), command:hookCommand(endpoint.command,[...args,'--hook-event','Watch'],false), asyncRewake:true }] : [])] }], [kind==='gemini_cli' ? 'BeforeAgent' : 'UserPromptSubmit']:[{ hooks:[handler(timeout)] }] } : {}),
    SessionEnd: [{ hooks: [handler(kind === 'codex_cli' ? 3 : timeout)] }],
    ...(kind === 'codex_cli' ? { Interrupt: [{ hooks: [handler(3)] }] } : {}),
    ...(kind === 'claude_code' ? { StopFailure: [{ hooks: [handler(timeout)] }] } : {}),
    // A message received during a long Bash/Edit call reaches the next model
    // request through a result boundary, without interrupting the running tool.
    ...(chat && kind === 'claude_code' ? {
      PostToolUse: [{ matcher: '.*', hooks: [handler(timeout)] }],
      PostToolUseFailure: [{ matcher: '.*', hooks: [handler(timeout)] }],
    } : {}),
  } : {}
  const [change, drift] = planJsonHooks({ home, path, keyPath: ['hooks'], value: hooks, manifest, cliKind: kind })
  return withLauncher(change ? [change] : [], drift)
}
