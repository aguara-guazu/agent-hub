export type CapabilityStatus = 'supported' | 'unsupported' | 'unverified'
export type ResumeCapabilityName = 'resume_by_id' | 'fork_headless' | 'fork_interactive' | 'headless_resume' | 'exclusive_resume' |
  'capture_id' | 'lifecycle_events' | 'profile_enforcement'

/** Documentary evidence for one capability. `flags` are the CLI flags that must appear in the installed binary's help. */
export interface CapabilityRecord {
  status: CapabilityStatus
  source: string | null
  checked_at: string
  flags?: string[]
  note?: string
}
export interface ResumeSurface {
  cli: string
  surface: string
  /** IDs are only interchangeable inside one namespace (ACP, CLI and IDE identifiers are distinct). */
  id_namespace: string
  id_source: string
  capabilities: Record<ResumeCapabilityName, CapabilityRecord>
}
export interface InstalledEvidence {
  version?: string
  /** Flags confirmed in the installed binary's help output. Absent means the binary was not inspected. */
  flags?: string[]
}

const CHECKED = '2026-10-28'
const doc = (source: string, extra: Partial<CapabilityRecord> = {}): CapabilityRecord => ({ status: 'supported', source, checked_at: CHECKED, ...extra })
const missing = (note: string, source: string | null = null): CapabilityRecord => ({ status: 'unverified', source, checked_at: CHECKED, note })
const absent = (note: string, source: string | null = null): CapabilityRecord => ({ status: 'unsupported', source, checked_at: CHECKED, note })

const CLAUDE_CLI = 'https://code.claude.com/docs/en/cli-reference'
const CLAUDE_HOOKS = 'https://code.claude.com/docs/en/hooks'
const CODEX_SERVER = 'https://learn.chatgpt.com/docs/app-server'
const CODEX_HOOKS = 'https://learn.chatgpt.com/docs/hooks'
const CODEX_COMMANDS = 'https://learn.chatgpt.com/docs/developer-commands?surface=cli'
const KIRO_HEADLESS = 'https://kiro.dev/docs/cli/headless/'
const KIRO_CHAT = 'https://kiro.dev/docs/cli/chat/'
const KIRO_HOOKS = 'https://kiro.dev/docs/hooks/types/'
const ACP_SETUP = 'https://agentclientprotocol.com/protocol/session-setup'
const GEMINI_SESSIONS = 'https://geminicli.com/docs/cli/session-management/'
const GEMINI_HOOKS = 'https://geminicli.com/docs/hooks/reference/'
const OPENCODE_CLI = 'https://opencode.ai/docs/cli/'
const OPENCODE_PLUGINS = 'https://opencode.ai/docs/plugins/'
const AGY_HEADLESS = 'https://antigravity.google/docs/cli/headless/'
const AGY_HOOKS = 'https://antigravity.google/docs/hooks'
const AGY_CONVERSATIONS = 'https://antigravity.google/docs/cli/conversations?platform=mac'
const CLAUDE_DESKTOP = 'https://code.claude.com/docs/en/desktop'

const NO_LOCK = 'La documentación no describe exclusión entre escritores de la misma sesión; otra instancia puede abrirla en cualquier momento.'
const NO_PROFILE = 'El perfil efectivo del adaptador no está verificado.'

/**
 * Documentation matrix by CLI and surface. A documented command proves the function exists, not that this adapter and
 * profile may use it: `effectiveCapability` additionally requires installed-binary evidence when flags are listed.
 * Everything not read in the official pages stays `unverified`.
 */
export const RESUME_CATALOG: readonly ResumeSurface[] = [
  { cli: 'claude_code', surface: 'fleet', id_namespace: 'claude_session', id_source: 'hook stdin session_id / stream-json system init',
    capabilities: {
      resume_by_id: doc(CLAUDE_CLI, { flags: ['--resume'] }),
      fork_headless: doc(CLAUDE_CLI, { flags: ['--resume', '--fork-session'], note: '--fork-session crea un ID nuevo; su combinación con --session-id no está documentada.' }),
      fork_interactive: doc(CLAUDE_CLI, { flags: ['--resume', '--fork-session'] }),
      headless_resume: doc(CLAUDE_CLI, { flags: ['--print', '--resume'] }),
      exclusive_resume: missing(NO_LOCK, CLAUDE_CLI),
      capture_id: doc(CLAUDE_HOOKS),
      lifecycle_events: doc(CLAUDE_HOOKS),
      profile_enforcement: missing(NO_PROFILE),
    } },
  { cli: 'claude_code', surface: 'interactive', id_namespace: 'claude_session', id_source: 'hook stdin session_id',
    capabilities: {
      resume_by_id: doc(CLAUDE_CLI, { flags: ['--resume'] }),
      fork_headless: doc(CLAUDE_CLI, { flags: ['--resume', '--fork-session', '--print'] }),
      fork_interactive: doc(CLAUDE_CLI, { flags: ['--resume', '--fork-session'] }),
      headless_resume: doc(CLAUDE_CLI, { flags: ['--print', '--resume'] }),
      exclusive_resume: missing(NO_LOCK, CLAUDE_CLI),
      capture_id: doc(CLAUDE_HOOKS),
      lifecycle_events: doc(CLAUDE_HOOKS),
      profile_enforcement: missing(NO_PROFILE),
    } },
  { cli: 'codex_cli', surface: 'fleet', id_namespace: 'codex_thread', id_source: 'app-server thread.id (thread.sessionId identifies the session tree root, not the thread)',
    capabilities: {
      resume_by_id: doc(CODEX_SERVER, { note: 'thread/resume con thread.id guardado.' }),
      fork_headless: doc(CODEX_SERVER, { note: 'thread/fork copia el historial y devuelve un thread.id nuevo; documenta threadId, lastTurnId, excludeTurns y ephemeral, no cwd, modelo ni sandbox: el perfil se fija en turn/start.' }),
      fork_interactive: doc(CODEX_COMMANDS, { note: 'codex fork <id>.' }),
      headless_resume: doc(CODEX_SERVER),
      exclusive_resume: missing(NO_LOCK, CODEX_SERVER),
      capture_id: doc(CODEX_HOOKS),
      lifecycle_events: doc(CODEX_HOOKS),
      profile_enforcement: missing(NO_PROFILE),
    } },
  { cli: 'codex_cli', surface: 'interactive', id_namespace: 'codex_thread', id_source: 'hook stdin session_id',
    capabilities: {
      resume_by_id: doc(CODEX_COMMANDS, { note: 'codex resume <id>.' }),
      fork_headless: doc(CODEX_COMMANDS, { note: 'codex exec fork <id> [PROMPT].' }),
      fork_interactive: doc(CODEX_COMMANDS, { note: 'codex fork <id>.' }),
      headless_resume: doc(CODEX_COMMANDS, { note: 'codex exec resume <id>.' }),
      exclusive_resume: missing(NO_LOCK, CODEX_COMMANDS),
      capture_id: doc(CODEX_HOOKS),
      lifecycle_events: doc(CODEX_HOOKS),
      profile_enforcement: missing(NO_PROFILE),
    } },
  { cli: 'kiro', surface: 'fleet', id_namespace: 'kiro_acp_session', id_source: 'ACP session/new result; no equivalence with --resume-id is verified',
    capabilities: {
      resume_by_id: missing('session/load sólo si initialize anuncia loadSession; se comprueba en cada arranque.', ACP_SETUP),
      fork_headless: missing('Fork no documentado.', KIRO_CHAT),
      fork_interactive: missing('Fork no documentado.', KIRO_CHAT),
      headless_resume: missing('--v3 --no-interactive --resume-id <id> es otra superficie con otro espacio de IDs.', KIRO_HEADLESS),
      exclusive_resume: missing(NO_LOCK, KIRO_CHAT),
      capture_id: doc(KIRO_HOOKS, { note: 'Los hooks Session Start/Agent Spawn traen session_id; el Hub no instala hooks de Kiro.' }),
      lifecycle_events: doc(ACP_SETUP, { note: 'session/prompt responde con stopReason al terminar el turno.' }),
      profile_enforcement: missing(NO_PROFILE),
    } },
  { cli: 'gemini_cli', surface: 'interactive', id_namespace: 'gemini_session', id_source: 'hook stdin session_id',
    capabilities: {
      resume_by_id: doc(GEMINI_SESSIONS, { flags: ['--resume'] }),
      fork_headless: missing('Fork por ID no verificado; la página documenta checkpoints.', GEMINI_SESSIONS),
      fork_interactive: missing('Fork por ID no verificado.', GEMINI_SESSIONS),
      headless_resume: missing('La combinación -p con --resume no tiene ejemplo en las páginas revisadas.', GEMINI_SESSIONS),
      exclusive_resume: missing(NO_LOCK, GEMINI_SESSIONS),
      capture_id: doc(GEMINI_HOOKS),
      lifecycle_events: doc(GEMINI_HOOKS, { note: 'AfterAgent puede solicitar retry y SessionEnd es best effort.' }),
      profile_enforcement: missing(NO_PROFILE),
    } },
  { cli: 'opencode', surface: 'interactive', id_namespace: 'opencode_session', id_source: 'plugin session events / API Session',
    capabilities: {
      resume_by_id: doc(OPENCODE_CLI, { flags: ['--session'] }),
      fork_headless: doc(OPENCODE_CLI, { flags: ['--session', '--fork'], note: 'opencode run --session <id> --fork.' }),
      fork_interactive: doc(OPENCODE_CLI, { flags: ['--session', '--fork'] }),
      headless_resume: doc(OPENCODE_CLI, { flags: ['--session'] }),
      exclusive_resume: missing(NO_LOCK, OPENCODE_CLI),
      capture_id: doc(OPENCODE_PLUGINS),
      lifecycle_events: doc(OPENCODE_PLUGINS),
      profile_enforcement: missing(NO_PROFILE),
    } },
  { cli: 'antigravity', surface: 'interactive', id_namespace: 'antigravity_conversation', id_source: 'hook conversationId / headless conversation_id',
    capabilities: {
      resume_by_id: doc(AGY_HEADLESS, { flags: ['--conversation'] }),
      fork_headless: missing('/fork es interactivo; no se verificó un flag o API headless.', AGY_CONVERSATIONS),
      fork_interactive: doc(AGY_CONVERSATIONS, { note: '/fork (/branch) crea una sesión independiente.' }),
      headless_resume: doc(AGY_HEADLESS, { flags: ['--conversation'] }),
      exclusive_resume: missing(NO_LOCK, AGY_HEADLESS),
      capture_id: doc(AGY_HOOKS),
      lifecycle_events: doc(AGY_HOOKS, { note: 'Stop sólo cierra el trabajo con fullyIdle=true.' }),
      profile_enforcement: missing(NO_PROFILE),
    } },
  { cli: 'claude_desktop', surface: 'code_tab', id_namespace: 'claude_session', id_source: 'hooks compartidos con la CLI',
    capabilities: {
      resume_by_id: doc(CLAUDE_DESKTOP, { note: 'claude --desktop --resume <id> continúa una sesión de la CLI en Desktop; no se hace con la sesión abierta.' }),
      fork_headless: absent('Desktop es interactivo y no ofrece --print.', CLAUDE_DESKTOP),
      fork_interactive: missing('Fork propio de Desktop no verificado.', CLAUDE_DESKTOP),
      headless_resume: absent('Desktop es interactivo y no ofrece --print.', CLAUDE_DESKTOP),
      exclusive_resume: missing(NO_LOCK, CLAUDE_DESKTOP),
      capture_id: missing('La recepción efectiva de los hooks desde la pestaña Code no está probada.', CLAUDE_DESKTOP),
      lifecycle_events: missing('Sin prueba de recepción de hooks.', CLAUDE_DESKTOP),
      profile_enforcement: missing(NO_PROFILE),
    } },
]

export function resumeSurface(cli: string, surface: string): ResumeSurface | undefined {
  return RESUME_CATALOG.find(item => item.cli === cli && item.surface === surface)
}

/**
 * Status usable by the ladder. A documented capability that lists flags is only effective when the installed binary
 * confirmed every one of them; an uninspected binary leaves it `unverified`.
 */
export function effectiveCapability(record: CapabilityRecord | undefined, installed?: InstalledEvidence): CapabilityStatus {
  if (!record || record.status !== 'supported') return record?.status ?? 'unverified'
  if (!record.flags?.length) return 'supported'
  if (!installed?.flags) return 'unverified'
  return record.flags.every(flag => installed.flags!.includes(flag)) ? 'supported' : 'unsupported'
}

/** Pulls the first dotted version out of `--version` output; anything else is not a version. */
export function parseCliVersion(output: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output)?.[1]
}

/** Flags present in a CLI's help output, limited to those the catalog asks about. */
export function helpFlags(help: string, wanted: Iterable<string>): string[] {
  return [...new Set(wanted)].filter(flag => new RegExp(`(?:^|[\\s,|\\[])${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'm').test(help))
}

/** IDs that must never restore a conversation: transport identifiers, "last session" markers, empty values. */
export function restorableNativeId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 300 && !/^tui:/.test(id) && !/^(?:last|latest|recent)$/i.test(id) && !/[\x00-\x1f\x7f\s]/.test(id)
}
