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

async function collectAgent(state: DaemonState, home: string, agentId: string, cli: ConsumptionCli, reader: Reader): Promise<void> {
  const client = new ConsumptionClient(state, agentId)
  if (!client.usageEnabled()) return
  const lease = join(state.root, "usage-consumption", `${agentId}.lock`)
  if (!acquireLease(lease)) return
  try {
    for (const link of await client.links()) {
      // Only hook-captured sessions are read from disk. Fleet runtime links have no file reader,
      // and kiro_env links wait for the Kiro disk reader.
      if (link.cli_kind !== cli || link.source !== "hook") continue
      const result = await reader(link, home).catch(() => null)
      if (!result) continue
      const cursor = {
        hub_session_id: link.hub_session_id,
        native_session_id: link.native_session_id,
        file_path: result.cursor.file_path,
        file_offset: result.cursor.file_offset,
        scan_state: result.cursor.scan_state,
      }
      if (result.events.length === 0) {
        await client.ingest([], cursor)
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
        const reader = READERS[cli]
        if (!reader) continue
        // A failure in one agent must not stop the others; the next cycle retries from the stored cursor.
        await collectAgent(state, home, agentId, cli, reader).catch(() => undefined)
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
