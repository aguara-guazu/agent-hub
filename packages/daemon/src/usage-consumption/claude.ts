import { readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { classifyTool, type ConsumptionEvent, type ConsumptionOrigin, type LinkCursor } from "@agenthub/shared"
import { blocks, num, parseLine, readFrom, textLength } from "./files.js"
import { cloneOriginState, distribute, type OriginState } from "./origins.js"

/** Reader state kept in the cursor. Offsets of subagent files live in `offsets`, keyed by path. */
export interface ClaudeScanState extends OriginState {
  tools: Record<string, string>
  offsets: Record<string, number>
  pending_compaction: boolean
}

export interface ClaudeReadResult {
  events: ConsumptionEvent[]
  cursor: { file_path: string; file_offset: number; scan_state: ClaudeScanState }
}

interface Pending {
  id: string
  model: string | null
  occurred_at: string
  usage: Record<string, any>
  compaction: boolean
  snapshot: OriginState
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

/** Walks one file's lines. Counts characters per origin and keeps the last usage seen for each message id. */
function scanLines(text: string, state: ClaudeScanState, pending: Map<string, Pending>, keyPrefix: string): void {
  for (const line of text.split("\n")) {
    if (!line) continue
    const row = parseLine(line)
    if (!row) continue
    const message = row.message as Record<string, any> | undefined
    if (row.isCompactSummary === true) {
      state.chars = { compaction: textLength(message?.content) }
      state.pending_compaction = true
      continue
    }
    if (!message) continue
    if (row.type === "assistant" && typeof message.id === "string") {
      for (const block of blocks(message.content)) {
        if (block.type === "text" || block.type === "thinking") {
          state.chars.model = (state.chars.model ?? 0) + (block.text ?? block.thinking ?? "").length
        } else if (block.type === "tool_use") {
          state.chars.model = (state.chars.model ?? 0) + JSON.stringify(block.input ?? {}).length
          if (block.id && block.name) state.tools[block.id] = block.name
        }
      }
      if (message.usage && typeof message.usage === "object") {
        const existing = pending.get(message.id)
        if (existing) {
          existing.usage = message.usage
          existing.snapshot = cloneOriginState(state)
        } else {
          const compaction = state.pending_compaction
          state.pending_compaction = false
          pending.set(message.id, {
            id: `${keyPrefix}${message.id}`,
            model: typeof message.model === "string" ? message.model : null,
            occurred_at: row.timestamp && !Number.isNaN(Date.parse(row.timestamp)) ? new Date(row.timestamp).toISOString() : new Date().toISOString(),
            usage: message.usage,
            compaction,
            snapshot: cloneOriginState(state),
          })
        }
      }
    } else if (row.type === "user") {
      if (typeof message.content === "string") {
        state.chars.person = (state.chars.person ?? 0) + message.content.length
        continue
      }
      for (const block of blocks(message.content)) {
        if (block.type === "text") {
          state.chars.person = (state.chars.person ?? 0) + (block.text ?? "").length
        } else if (block.type === "tool_result") {
          const name = (block.tool_use_id && state.tools[block.tool_use_id]) || ""
          const origin: ConsumptionOrigin = classifyTool(name)
          state.chars[origin] = (state.chars[origin] ?? 0) + textLength(block.content)
          if (block.tool_use_id) delete state.tools[block.tool_use_id]
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
      dedupe_key: entry.id,
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
      context_tokens: context,
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

function priorState(raw: unknown): ClaudeScanState {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<ClaudeScanState>
  return {
    chars: value.chars && typeof value.chars === "object" ? { ...value.chars } : {},
    tools: value.tools && typeof value.tools === "object" ? { ...value.tools } : {},
    offsets: value.offsets && typeof value.offsets === "object" ? { ...value.offsets } : {},
    pending_compaction: value.pending_compaction === true,
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
  scanLines(main.text, state, pending, "cc:")
  for (const path of await subagentFiles(mainPath, link.native_session_id)) {
    const read = await readFrom(path, state.offsets[path] ?? 0).catch(() => null)
    if (!read) continue
    state.offsets[path] = read.offset
    scanLines(read.text, state, pending, `ccs:${basename(path, ".jsonl")}:`)
  }
  return {
    events: toEvents(pending, link.hub_session_id, link.native_session_id),
    cursor: { file_path: mainPath, file_offset: main.offset, scan_state: state },
  }
}
