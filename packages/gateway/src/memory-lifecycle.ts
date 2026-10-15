import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MEMORY_META_KEY } from './memory-bridge.js'
import { MemoryOutbox } from './memory-outbox.js'
import { renameRetry } from './platform.js'

export interface NativeSession { agent_id: string; cli_kind: string; client: string; session_id: string; cwd: string | null }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
export function nativeSession(agentId: string, cliKind: string, sessionId: string, cwd: unknown): NativeSession {
  return { agent_id: agentId, cli_kind: cliKind, client: cliKind, session_id: `native:${digest([agentId, sessionId])}`,
    cwd: typeof cwd === 'string' && cwd.length <= 4000 ? cwd : null }
}
function exposedTool(name: string) { return name.replace(/^mcp__hub__|^mcp_hub_|^hub__+|^hub_/, '') }
const receiptKey = (name: string, args: unknown) => digest([exposedTool(name), args])

/** Hook receipts contain only a digest, never tool arguments, prompts or transcript contents. */
export async function recordLifecycle(directory: string, agentId: string, cliKind: string, event: Record<string, any>) {
  if (cliKind === 'antigravity') {
    // Stop can fire while background work is still running; do not close those notes.
    if (event.hook_event_name === 'Stop' && event.fullyIdle !== true) return
    event = { ...event, session_id: event.conversationId, cwd: Array.isArray(event.workspacePaths) ? event.workspacePaths[0] : undefined,
      tool_name: event.toolCall?.name, tool_input: event.toolCall?.args,
      hook_event_name: event.hook_event_name === 'Stop' && (event.error || event.terminationReason === 'error') ? 'StopFailure' : event.hook_event_name }
  }
  const session = event.session_id ?? event.sessionID
  if (typeof session !== 'string' || !session || session.length > 300) return
  const who = nativeSession(agentId, cliKind, session, event.cwd)
  const name = String(event.hook_event_name ?? '')
  if (['PreToolUse', 'BeforeTool'].includes(name) && typeof event.tool_name === 'string') {
    const receipts = join(directory, 'calls'); await mkdir(receipts, { recursive: true, mode: 0o700 })
    const path = join(receipts, `${receiptKey(event.tool_name, event.tool_input ?? {})}-${randomUUID()}.json`)
    await writeFile(`${path}.tmp`, JSON.stringify({ who, at: Date.now() }), { mode: 0o600 })
    await renameRetry(`${path}.tmp`, path).catch(async (error: unknown) => { await rm(`${path}.tmp`, { force: true }); throw error })
  } else if (['Stop', 'AfterAgent', 'SessionEnd', 'Interrupt', 'StopFailure'].includes(name)) {
    await new MemoryOutbox(directory).enqueue({ operation: 'finish_notes', args: { reason: name === 'SessionEnd' ? 'session_end' : 'turn_end',
      ...(name === 'Interrupt' || name === 'StopFailure' ? { state: 'blocked' } : {}), before: new Date().toISOString() }, meta: { [MEMORY_META_KEY]: who } })
  }
}

/** Do not guess when two concurrent native sessions issue the exact same call. */
export async function sessionForCall(directory: string, name: string, args: unknown): Promise<NativeSession | undefined> {
  const receipts = join(directory, 'calls'), prefix = receiptKey(name, args)
  const names = (await readdir(receipts).catch(() => [])).filter(n => n.endsWith('.json'))
  const matches: { path: string; who: NativeSession }[] = []
  for (const file of names) {
    const path = join(receipts, file)
    try {
      const value = JSON.parse(await readFile(path, 'utf8'))
      if (Date.now() - value.at > 120_000) { await rm(path, { force: true }); continue }
      if (file.startsWith(prefix)) matches.push({ path, who: value.who })
    } catch { /* A competing gateway may have consumed it. */ }
  }
  if (new Set(matches.map(m => m.who.session_id)).size !== 1) return undefined
  const match = matches[0]!
  // Atomic claim prevents two gateway processes from consuming the same receipt.
  try { await rename(match.path, `${match.path}.claimed`); await rm(`${match.path}.claimed`, { force: true }); return match.who } catch { return undefined }
}
