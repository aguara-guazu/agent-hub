import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { classifyTool, type ConsumptionEvent, type ConsumptionOrigin, type LinkCursor } from "@agenthub/shared"
import { blocks, num, parseLine, readFrom, textLength } from "./files.js"
import { cloneOriginState, distribute, type OriginState } from "./origins.js"

/** Origin state of one file: a session file, or one subagent file with its own characters. */
export interface FileScan extends OriginState {
  tools: Record<string, string>
  pending_compaction: boolean
}

/** Cursor state. The main file offset is in the cursor; subagent offsets and states are kept here by path. */
export interface ClaudeScanState extends FileScan {
  offsets: Record<string, number>
  subagents: Record<string, FileScan>
}

export interface ClaudeReadResult {
  events: ConsumptionEvent[]
  cursor: { file_path: string; file_offset: number; scan_state: ClaudeScanState }
}

interface Pending {
  /** Dedupe key shared by every file, so one response counts once even when it appears in several files. */
  dedupe_key: string
  model: string | null
  occurred_at: string
  usage: Record<string, any>
  compaction: boolean
  snapshot: OriginState
  subagent: boolean
}

export function claudeConfigDir(home: string): string {
  return process.env.CLAUDE_CONFIG_DIR || join(home, ".claude")
}

async function findMainFile(nativeId: string, home: string): Promise<string | null> {
  const projects = join(claudeConfigDir(home), "projects")
  let directories: string[]
  try {
    directories = await readdir(projects)
  } catch {
    return null
  }
  for (const directory of directories) {
    const candidate = join(projects, directory, `${nativeId}.jsonl`)
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      /* not in this project directory */
    }
  }
  return null
}

async function subagentFiles(mainPath: string, nativeId: string): Promise<string[]> {
  const directory = join(mainPath.slice(0, -`${nativeId}.jsonl`.length), nativeId, "subagents")
  try {
    return (await readdir(directory)).filter(name => name.endsWith(".jsonl")).map(name => join(directory, name)).sort()
  } catch {
    return []
  }
}

/**
 * Walks one file's lines. Counts characters into that file's origin state and keeps the last usage seen
 * for each message id. `pending` is keyed by file and message id, so the same id in two files stays two entries.
 */
function scanLines(text: string, scan: FileScan, pending: Map<string, Pending>, file: string, subagent: boolean): void {
  for (const line of text.split("\n")) {
    if (!line) continue
    const row = parseLine(line)
    if (!row) continue
    const message = row.message as Record<string, any> | undefined
    if (row.isCompactSummary === true) {
      scan.chars = { compaction: textLength(message?.content) }
      scan.pending_compaction = true
      continue
    }
    if (!message) continue
    if (row.type === "assistant" && typeof message.id === "string") {
      for (const block of blocks(message.content)) {
        if (block.type === "text" || block.type === "thinking") {
          scan.chars.model = (scan.chars.model ?? 0) + (block.text ?? block.thinking ?? "").length
        } else if (block.type === "tool_use") {
          scan.chars.model = (scan.chars.model ?? 0) + JSON.stringify(block.input ?? {}).length
          if (block.id && block.name) scan.tools[block.id] = block.name
        }
      }
      if (message.usage && typeof message.usage === "object") {
        const key = `${file}|${message.id}`
        const existing = pending.get(key)
        if (existing) {
          existing.usage = message.usage
          existing.snapshot = cloneOriginState(scan)
        } else {
          const compaction = scan.pending_compaction
          scan.pending_compaction = false
          pending.set(key, {
            dedupe_key: `cc:${message.id}`,
            model: typeof message.model === "string" ? message.model : null,
            occurred_at: row.timestamp && !Number.isNaN(Date.parse(row.timestamp)) ? new Date(row.timestamp).toISOString() : new Date().toISOString(),
            usage: message.usage,
            compaction,
            snapshot: cloneOriginState(scan),
            subagent,
          })
        }
      }
    } else if (row.type === "user") {
      if (typeof message.content === "string") {
        scan.chars.person = (scan.chars.person ?? 0) + message.content.length
        continue
      }
      for (const block of blocks(message.content)) {
        if (block.type === "text") {
          scan.chars.person = (scan.chars.person ?? 0) + (block.text ?? "").length
        } else if (block.type === "tool_result") {
          const name = (block.tool_use_id && scan.tools[block.tool_use_id]) || ""
          const origin: ConsumptionOrigin = classifyTool("claude_code", name)
          scan.chars[origin] = (scan.chars[origin] ?? 0) + textLength(block.content)
          if (block.tool_use_id) delete scan.tools[block.tool_use_id]
        }
      }
    }
  }
}

function toEvents(pending: Map<string, Pending>, hubId: string, nativeId: string): ConsumptionEvent[] {
  const events: ConsumptionEvent[] = []
  for (const entry of pending.values()) {
    const usage = entry.usage
    const input = num(usage.input_tokens)
    const output = num(usage.output_tokens)
    const cacheWrite = num(usage.cache_creation_input_tokens)
    const cacheWrite1h = Math.min(cacheWrite, num(usage.cache_creation?.ephemeral_1h_input_tokens))
    const cacheRead = num(usage.cache_read_input_tokens)
    const context = input + cacheWrite + cacheRead
    events.push({
      dedupe_key: entry.dedupe_key,
      hub_session_id: hubId,
      native_session_id: nativeId,
      cli_kind: "claude_code",
      model: entry.model,
      occurred_at: entry.occurred_at,
      unit: "tokens",
      input,
      output,
      cache_write: cacheWrite,
      cache_write_1h: cacheWrite1h,
      cache_read: cacheRead,
      credits: 0,
      // Subagent events do not report the session's context window, so they carry no context size.
      context_tokens: entry.subagent ? null : context,
      context_window: null,
      context_pct: null,
      compaction: entry.compaction,
      model_calls: 1,
      breakdown: distribute(entry.snapshot, context, output),
      source: "file",
    })
  }
  return events
}

function emptyScan(): FileScan {
  return { chars: {}, tools: {}, pending_compaction: false }
}

function priorState(raw: unknown): ClaudeScanState {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<ClaudeScanState>
  return {
    chars: value.chars && typeof value.chars === "object" ? { ...value.chars } : {},
    tools: value.tools && typeof value.tools === "object" ? { ...value.tools } : {},
    pending_compaction: value.pending_compaction === true,
    offsets: value.offsets && typeof value.offsets === "object" ? { ...value.offsets } : {},
    subagents: value.subagents && typeof value.subagents === "object" ? { ...value.subagents } : {},
  }
}

/** Reads new lines of a Claude Code session and its subagents. Returns null when the session file does not exist. */
export async function readClaudeSession(link: LinkCursor, home: string): Promise<ClaudeReadResult | null> {
  const mainPath = link.file_path ?? (await findMainFile(link.native_session_id, home))
  if (!mainPath) return null
  const state = priorState(link.scan_state)
  const main = await readFrom(mainPath, link.file_path ? link.file_offset : 0).catch(() => null)
  if (!main) return null
  if (main.restarted) {
    state.chars = {}
    state.tools = {}
    state.pending_compaction = false
  }
  const pending = new Map<string, Pending>()
  scanLines(main.text, state, pending, mainPath, false)
  for (const path of await subagentFiles(mainPath, link.native_session_id)) {
    const read = await readFrom(path, state.offsets[path] ?? 0).catch(() => null)
    if (!read) continue
    const scan = read.restarted ? emptyScan() : (state.subagents[path] ?? emptyScan())
    scanLines(read.text, scan, pending, path, true)
    state.subagents[path] = scan
    state.offsets[path] = read.offset
  }
  return {
    events: toEvents(pending, link.hub_session_id, link.native_session_id),
    cursor: { file_path: mainPath, file_offset: main.offset, scan_state: state },
  }
}
