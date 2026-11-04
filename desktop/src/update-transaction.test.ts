import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { advancePhase, canAdvance, journalFile, readTransaction, writeJsonDurable, type UpdateTransaction } from "./update-transaction.js"

const paths: string[] = []
const transaction = (dir: string): UpdateTransaction => ({
  schema: 1,
  transaction_id: "tx-12345678",
  phase: "staged",
  from: { version: "1.0.0", digest: "a".repeat(64) },
  to: { version: "1.1.0", digest: "b".repeat(64), size: 42, auth: "integrity_only" },
  paths: {
    installed: join(dir, "Agent Hub.app"),
    incoming: join(dir, "Agent Hub.app.incoming-tx-12345678"),
    runtime_old: join(dir, "runtime", "versions", "1.0.0", "Agent Hub.app"),
  },
  old_app: { pid: 100, start: "old-start" },
  new_app: null,
  watchdog: { pid: 101, start: "watchdog-start" },
  updated_at: new Date().toISOString(),
})

afterEach(async () => {
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("transacción del updater", () => {
  it("solo admite transiciones consecutivas o terminales", () => {
    expect(canAdvance("staged", "watchdog_ready")).toBe(true)
    expect(canAdvance("watchdog_ready", "swap_intent")).toBe(true)
    expect(canAdvance("swap_intent", "swapped")).toBe(true)
    expect(canAdvance("swapped", "launched")).toBe(true)
    expect(canAdvance("launched", "healthy")).toBe(true)
    expect(canAdvance("healthy", "done")).toBe(true)
    expect(canAdvance("staged", "healthy")).toBe(false)
    expect(canAdvance("launched", "swapped")).toBe(false)
    expect(canAdvance("rolled_back", "done")).toBe(false)
    expect(canAdvance("swapped", "rolled_back")).toBe(true)
    expect(canAdvance("swap_intent", "ambiguous")).toBe(true)
  })

  it("persiste cada fase y rechaza saltos sin alterar el journal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenthub-update-tx-"))
    paths.push(dir)
    const tx = transaction(dir)
    writeJsonDurable(journalFile(dir), tx)

    expect(() => advancePhase(dir, tx.transaction_id, "healthy")).toThrow("fase")
    expect(readTransaction(dir)).toMatchObject({ kind: "ok", tx: { phase: "staged" } })

    advancePhase(dir, tx.transaction_id, "watchdog_ready")
    advancePhase(dir, tx.transaction_id, "swap_intent")
    advancePhase(dir, tx.transaction_id, "swapped")
    advancePhase(dir, tx.transaction_id, "launched", { new_app: { pid: 102, start: "new-start" } })

    expect(readTransaction(dir)).toMatchObject({ kind: "ok", tx: { phase: "launched", new_app: { pid: 102, start: "new-start" } } })
  })
})
