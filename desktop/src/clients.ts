/**
 * Reinicio de un cliente de escritorio para que cargue los cambios del hub.
 *
 * Hoy sólo Claude Desktop: es la única app gráfica que el hub configura y que lee su lista
 * de herramientas una sola vez, al abrirse. Los CLIs se reinician con una sesión nueva y
 * no hace falta tocarlos.
 *
 * - macOS: se pide el cierre por Apple Events (`osascript ... to quit`, que la primera vez
 *   dispara el permiso de Automatización), se espera que el proceso `Claude` termine y se
 *   vuelve a abrir por bundle id. Bundle id verificado en `/Applications/Claude.app`:
 *   `com.anthropic.claudefordesktop`.
 * - Windows: cierre por `CloseMainWindow` y relanzamiento por el ejecutable de la
 *   instalación clásica (`%LOCALAPPDATA%\AnthropicClaude\claude.exe`,
 *   https://github.com/anthropics/claude-code/issues/28543) o el alias de la instalación
 *   MSIX (`%LOCALAPPDATA%\Microsoft\WindowsApps\Claude.exe`,
 *   https://dev.to/arthamjayanth/fixing-claude-codes-desktop-on-windows-claude-desktop-is-not-installed-microsoft-storemsix-130a);
 *   si ninguno existe, por el esquema `claude://`. No se probó en una máquina Windows.
 * - Nunca se fuerza el cierre: si la app no termina sola, se informa y decide la persona.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

export const CLAUDE_DESKTOP_BUNDLE_ID = 'com.anthropic.claudefordesktop'
const CLAUDE_DESKTOP_PROCESS_MAC = 'Claude'
const CLAUDE_DESKTOP_PROCESS_WIN = 'Claude.exe'
/** Tope de espera para que la app termine sola. */
const CLOSE_TIMEOUT_MS = 15_000
const POLL_MS = 250

export interface CommandResult {
  code: number
  stdout: string
}

export interface ClientDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** Ejecuta y espera; nunca lanza, devuelve el código de salida. */
  run(command: string, args: string[]): Promise<CommandResult>
  /** Lanza sin esperar ni heredar la vida del hub. */
  launch(command: string, args: string[]): void
  exists(path: string): boolean
  sleep(ms: number): Promise<void>
}

export interface RestartOutcome {
  ok: boolean
  detail: string
}

export function defaultClientDeps(): ClientDeps {
  return {
    platform: process.platform,
    env: process.env,
    run: (command, args) => new Promise((resolve) => {
      execFile(command, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => {
        const code = error ? ((error as { code?: unknown }).code as number | undefined) ?? 1 : 0
        resolve({ code: typeof code === 'number' ? code : 1, stdout: String(stdout ?? '') })
      })
    }),
    launch: (command, args) => {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => undefined)
      child.unref()
    },
    exists: existsSync,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

export function supportsClientRestart(cliKind: string, platform: NodeJS.Platform): boolean {
  return cliKind === 'claude_desktop' && (platform === 'darwin' || platform === 'win32')
}

export async function isClientRunning(cliKind: string, deps: ClientDeps): Promise<boolean> {
  if (cliKind !== 'claude_desktop') return false
  if (deps.platform === 'darwin') {
    return (await deps.run('pgrep', ['-x', CLAUDE_DESKTOP_PROCESS_MAC])).code === 0
  }
  if (deps.platform === 'win32') {
    const result = await deps.run('tasklist', ['/FI', `IMAGENAME eq ${CLAUDE_DESKTOP_PROCESS_WIN}`, '/NH'])
    return result.code === 0 && result.stdout.toLowerCase().includes(CLAUDE_DESKTOP_PROCESS_WIN.toLowerCase())
  }
  return false
}

async function waitUntilClosed(cliKind: string, deps: ClientDeps): Promise<boolean> {
  const deadline = Date.now() + CLOSE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!(await isClientRunning(cliKind, deps))) return true
    await deps.sleep(POLL_MS)
  }
  return !(await isClientRunning(cliKind, deps))
}

/** Rutas donde puede estar el ejecutable de Claude Desktop en Windows, en orden de preferencia. */
export function windowsLaunchCandidates(env: NodeJS.ProcessEnv): string[] {
  const local = env['LOCALAPPDATA']
  if (!local) return []
  return [win32.join(local, 'AnthropicClaude', 'claude.exe'), win32.join(local, 'Microsoft', 'WindowsApps', 'Claude.exe')]
}

/** Cierra Claude Desktop con cortesía y la vuelve a abrir. Con la app cerrada, sólo la abre. */
export async function restartClient(cliKind: string, deps: ClientDeps = defaultClientDeps()): Promise<RestartOutcome> {
  if (!supportsClientRestart(cliKind, deps.platform)) {
    return { ok: false, detail: `el hub no sabe reiniciar ${cliKind} en ${deps.platform}` }
  }
  const running = await isClientRunning(cliKind, deps)
  if (running) {
    if (deps.platform === 'darwin') {
      const quit = await deps.run('osascript', ['-e', `tell application id "${CLAUDE_DESKTOP_BUNDLE_ID}" to quit`])
      // Sin permiso de Automatización el pedido falla; SIGTERM también cierra un Electron con cortesía.
      if (quit.code !== 0) await deps.run('pkill', ['-TERM', '-x', CLAUDE_DESKTOP_PROCESS_MAC])
    } else {
      await deps.run('powershell', [
        '-NoProfile', '-Command',
        `Get-Process -Name ${CLAUDE_DESKTOP_PROCESS_WIN.replace(/\.exe$/i, '')} -ErrorAction SilentlyContinue | ForEach-Object { $null = $_.CloseMainWindow() }`,
      ])
    }
    if (!(await waitUntilClosed(cliKind, deps))) {
      return { ok: false, detail: 'Claude Desktop no se cerró sola en 15 segundos; cerrala a mano y volvé a abrirla para que cargue los cambios' }
    }
  }
  if (deps.platform === 'darwin') {
    const opened = await deps.run('open', ['-b', CLAUDE_DESKTOP_BUNDLE_ID])
    if (opened.code !== 0) return { ok: false, detail: 'Claude Desktop se cerró pero no se pudo volver a abrir; abrila desde Aplicaciones' }
    return { ok: true, detail: running ? 'Claude Desktop se cerró y se volvió a abrir.' : 'Claude Desktop no estaba abierta; se abrió.' }
  }
  const executable = windowsLaunchCandidates(deps.env).find((path) => deps.exists(path))
  if (executable) deps.launch(executable, [])
  else deps.launch('cmd', ['/c', 'start', '', 'claude://'])
  return { ok: true, detail: running ? 'Claude Desktop se cerró y se volvió a abrir.' : 'Claude Desktop no estaba abierta; se abrió.' }
}
