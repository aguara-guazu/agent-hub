import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { classifyTool, type ConsumptionEvent, type ConsumptionOrigin, type LinkCursor } from "@agenthub/shared"
import { num, parseLine, readFrom, textLength, type SessionReadResult } from "./files.js"
import { cloneOriginState, distribute, type OriginState } from "./origins.js"

/** Reader state kept in the cursor: the origin characters plus values carried from earlier records. */
export interface CodexScanState extends OriginState {
  tools: Record<string, string>
  model: string | null
  reasoning_included: boolean | null
  context_window: number | null
  pending_compaction: boolean
}

interface Pending {
  id: string
  model: string | null
  occurred_at: string
  usage: Record<string, any>
  reasoning_included: boolean | null
  context_window: number | null
  compaction: boolean
  snapshot: OriginState
}

/** Locates `sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`, the layout Codex writes. */
async function findRollout(directory: string, nativeId: string, depth = 0): Promise<string | null> {
  let entries: { name: string; isDirectory(): boolean }[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${nativeId}.jsonl`)) return join(directory, entry.name)
  }
  if (depth >= 3) return null
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findRollout(join(directory, entry.name), nativeId, depth + 1)
    if (found) return found
  }
  return null
}

function outputLength(value: unknown): number {
  if (typeof value === "string") return value.length
  if (Array.isArray(value)) return textLength(value)
  return value === undefined ? 0 : JSON.stringify(value).length
}

function scanLines(text: string, state: CodexScanState, pending: Map<string, Pending>, nativeId: string): void {
  for (const line of text.split("\n")) {
    if (!line) continue
    const row = parseLine(line)
    if (!row) continue
    const payload = (row.payload ?? {}) as Record<string, any>
    switch (row.type) {
      case "turn_context":
        if (typeof payload.model === "string") state.model = payload.model
        break
      case "event_msg":
        if (payload.type === "token_count" && payload.info && typeof payload.info === "object") {
          if (typeof payload.info.last_usage_includes_reasoning === "boolean") state.reasoning_included = payload.info.last_usage_includes_reasoning
          if (typeof payload.info.model_context_window === "number") state.context_window = payload.info.model_context_window
        }
        break
      case "compacted":
        state.chars = { compaction: JSON.stringify(payload).length }
        state.pending_compaction = true
        break
      case "token_usage_record": {
        const usage = (payload.usage ?? {}) as Record<string, any>
        const key = typeof payload.response_id === "string" && payload.response_id ? `cx:${payload.response_id}` : `cx:${nativeId}:${String(row.ordinal ?? pending.size)}`
        const existing = pending.get(key)
        if (existing) {
          existing.usage = usage
          existing.snapshot = cloneOriginState(state)
          break
        }
        const compaction = state.pending_compaction
        state.pending_compaction = false
        pending.set(key, {
          id: key,
          model: state.model,
          occurred_at: typeof row.timestamp === "string" && !Number.isNaN(Date.parse(row.timestamp)) ? new Date(row.timestamp).toISOString() : new Date().toISOString(),
          usage,
          reasoning_included: state.reasoning_included,
          context_window: state.context_window,
          compaction,
          snapshot: cloneOriginState(state),
        })
        break
      }
      case "response_item":
        scanResponseItem(payload, state)
        break
    }
  }
}

/**
 * Origin of a tool call's output. Codex 0.166 calls MCP tools from inside `exec`, so an exec
 * is classified by the MCP tool names its code invokes. Only the names are inspected; the text is never kept.
 */
function callOrigin(name: string, args: unknown): string {
  if (name !== "exec") return classifyTool("codex_cli", name)
  const code = typeof args === "string" ? args : JSON.stringify(args ?? "")
  if (/mcp__hub[.__]/.test(code)) return "hub_tools"
  if (/mcp__/.test(code)) return "mcp_tools"
  return "cli_tools"
}

function scanResponseItem(payload: Record<string, any>, state: CodexScanState): void {
  switch (payload.type) {
    case "message": {
      const origin: ConsumptionOrigin = payload.role === "user" ? "person" : payload.role === "assistant" ? "model" : "fixed"
      state.chars[origin] = (state.chars[origin] ?? 0) + textLength(payload.content)
      break
    }
    case "reasoning":
      state.chars.model = (state.chars.model ?? 0) + textLength(payload.summary)
      break
    case "function_call":
    case "custom_tool_call": {
      const name = typeof payload.name === "string" ? payload.name : ""
      const args = payload.arguments ?? payload.input
      const origin = classifyTool("codex_cli", name)
      state.chars[origin] = (state.chars[origin] ?? 0) + outputLength(args)
      // The output of this call is classified by the call itself, so it is remembered by origin, not by text.
      if (typeof payload.call_id === "string") state.tools[payload.call_id] = callOrigin(name, args)
      break
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const origin = (typeof payload.call_id === "string" && state.tools[payload.call_id]) || "cli_tools"
      state.chars[origin as ConsumptionOrigin] = (state.chars[origin as ConsumptionOrigin] ?? 0) + outputLength(payload.output)
      if (typeof payload.call_id === "string") delete state.tools[payload.call_id]
      break
    }
  }
}

function toEvents(pending: Map<string, Pending>, hubId: string, nativeId: string): ConsumptionEvent[] {
  const events: ConsumptionEvent[] = []
  for (const entry of pending.values()) {
    const usage = entry.usage
    const cacheRead = num(usage.cached_input_tokens)
    const input = Math.max(0, num(usage.input_tokens) - cacheRead)
    const cacheWrite = num(usage.cache_write_input_tokens)
    const reasoning = entry.reasoning_included === false ? num(usage.reasoning_output_tokens) : 0
    const output = num(usage.output_tokens) + reasoning
    const context = input + cacheWrite + cacheRead
    events.push({
      dedupe_key: entry.id,
      hub_session_id: hubId,
      native_session_id: nativeId,
      cli_kind: "codex_cli",
      model: entry.model,
      occurred_at: entry.occurred_at,
      unit: "tokens",
      input,
      output,
      cache_write: cacheWrite,
      cache_write_1h: 0,
      cache_read: cacheRead,
      credits: 0,
      context_tokens: context,
      context_window: entry.context_window,
      context_pct: null,
      compaction: entry.compaction,
      model_calls: 1,
      breakdown: distribute(entry.snapshot, context, output),
      source: "file",
    })
  }
  return events
}

function priorState(raw: unknown): CodexScanState {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<CodexScanState>
  return {
    chars: value.chars && typeof value.chars === "object" ? { ...value.chars } : {},
    tools: value.tools && typeof value.tools === "object" ? { ...value.tools } : {},
    model: typeof value.model === "string" ? value.model : null,
    reasoning_included: typeof value.reasoning_included === "boolean" ? value.reasoning_included : null,
    context_window: typeof value.context_window === "number" ? value.context_window : null,
    pending_compaction: value.pending_compaction === true,
  }
}

/** Reads new records of a Codex rollout. Returns null when the session file does not exist. */
export async function readCodexSession(link: LinkCursor, home: string): Promise<SessionReadResult | null> {
  const path = link.file_path ?? (await findRollout(join(process.env.CODEX_HOME || join(home, ".codex"), "sessions"), link.native_session_id))
  if (!path) return null
  const state = priorState(link.scan_state)
  const read = await readFrom(path, link.file_path ? link.file_offset : 0).catch(() => null)
  if (!read) return null
  if (read.restarted) {
    state.chars = {}
    state.tools = {}
    state.pending_compaction = false
  }
  const pending = new Map<string, Pending>()
  scanLines(read.text, state, pending, link.native_session_id)
  return {
    events: toEvents(pending, link.hub_session_id, link.native_session_id),
    cursor: { file_path: path, file_offset: read.offset, scan_state: state },
  }
}
