import { mkdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import type { ConsumptionCli, LinkCursor } from "@agenthub/shared"
import type { DaemonState } from "../state.js"
import { ConsumptionClient } from "./client.js"
import { readClaudeSession } from "./claude.js"
import { readCodexSession } from "./codex.js"
import type { SessionReadResult } from "./files.js"

const CYCLE_MS = 60_000
/** Longer than a cycle, so an import of a large first pass does not lose its lease. A crashed run frees it after this. */
const LEASE_MS = 300_000
const BATCH = 500
/** A link without a session file is searched for at most once an hour. */
const NOT_FOUND_RETRY_MS = 3_600_000

function recentlyNotFound(link: LinkCursor): boolean {
  const at = (link.scan_state as { not_found_at?: unknown } | null)?.not_found_at
  return link.file_path === null && typeof at === "string" && Date.now() - Date.parse(at) < NOT_FOUND_RETRY_MS
}

type Reader = (link: LinkCursor, home: string) => Promise<SessionReadResult | null>

const READERS: Partial<Record<ConsumptionCli, Reader>> = {
  claude_code: readClaudeSession,
  codex_cli: readCodexSession,
}

/** One collector per machine state root and agent. A lease directory keeps two daemons from reading the same links. */
function acquireLease(directory: string): boolean {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return true
  } catch {
    /* lease exists; take it over only when it has gone stale */
  }
  try {
    if (Date.now() - statSync(directory).mtimeMs > LEASE_MS) {
      rmSync(directory, { recursive: true, force: true })
      mkdirSync(directory, { mode: 0o700 })
      return true
    }
  } catch {
    /* another process took the lease first */
  }
  return false
}

async function collectAgent(state: DaemonState, home: string, agentId: string): Promise<void> {
  const client = new ConsumptionClient(state, agentId)
  if (!client.usageEnabled()) return
  const lease = join(state.root, "usage-consumption", `${agentId}.lock`)
  if (!acquireLease(lease)) return
  try {
    for (const link of await client.links()) {
      // Hub team members get only fleet_runtime links: their hooks skip hub_fleet sessions.
      // kiro_env links wait for the Kiro disk reader.
      const reader = READERS[link.cli_kind]
      if (!reader || (link.source !== "hook" && link.source !== "fleet_runtime")) continue
      if (recentlyNotFound(link)) continue
      let result: SessionReadResult | null
      try {
        result = await reader(link, home)
      } catch {
        // A read error is not a missing file: keep the cursor and retry on the next cycle.
        continue
      }
      if (!result) {
        // The only ingest without events: it stores when the file was searched for, so it is not searched again each cycle.
        await client.ingest([], {
          hub_session_id: link.hub_session_id,
          native_session_id: link.native_session_id,
          file_path: null,
          file_offset: 0,
          scan_state: { not_found_at: new Date().toISOString() },
        })
        continue
      }
      const cursor = {
        hub_session_id: link.hub_session_id,
        native_session_id: link.native_session_id,
        file_path: result.cursor.file_path,
        file_offset: result.cursor.file_offset,
        scan_state: result.cursor.scan_state,
      }
      if (result.events.length === 0) {
        const unchanged = result.cursor.file_offset === link.file_offset
          && result.cursor.file_path === link.file_path
          && JSON.stringify(result.cursor.scan_state) === JSON.stringify(link.scan_state)
        if (!unchanged) await client.ingest([], cursor)
        continue
      }
      for (let start = 0; start < result.events.length; start += BATCH) {
        const batch = result.events.slice(start, start + BATCH)
        const last = start + BATCH >= result.events.length
        await client.ingest(batch, last ? cursor : undefined)
      }
    }
  } finally {
    rmSync(lease, { recursive: true, force: true })
  }
}

/**
 * Reads the session files of every installed Claude Code and Codex agent once a minute.
 * Each agent sends its figures to memory; cursors make later cycles read only new lines.
 */
export function startConsumptionCollectors(state: DaemonState, home: string): { close(): void } {
  let running = false
  const cycle = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      for (const [agentId, snapshot] of Object.entries(state.allSnapshots())) {
        const cli = String(snapshot["cli_kind"]) as ConsumptionCli
        if (!READERS[cli]) continue
        // A failure in one agent must not stop the others; the next cycle retries from the stored cursor.
        await collectAgent(state, home, agentId).catch(() => undefined)
      }
    } finally {
      running = false
    }
  }
  void cycle()
  const timer = setInterval(() => void cycle(), CYCLE_MS)
  timer.unref()
  return { close: () => clearInterval(timer) }
}
