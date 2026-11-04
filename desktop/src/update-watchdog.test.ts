import { describe, expect, it, vi } from "vitest"
import { performForwardSwap, type ForwardSwapOperations } from "./update-watchdog.js"
import type { Phase, UpdateTransaction } from "./update-transaction.js"

const transaction = (): UpdateTransaction => ({
  schema: 1,
  transaction_id: "tx-12345678",
  phase: "swap_intent",
  from: { version: "1.0.0", digest: "a".repeat(64) },
  to: { version: "1.1.0", digest: "b".repeat(64), size: 42, auth: "integrity_only" },
  paths: {
    installed: "/tmp/Agent Hub.app",
    incoming: "/tmp/Agent Hub.app.incoming-tx-12345678",
    runtime_old: "/tmp/runtime/versions/1.0.0/Agent Hub.app",
  },
  old_app: { pid: 100, start: "old-start" },
  new_app: null,
  watchdog: { pid: 101, start: "watchdog-start" },
  updated_at: new Date().toISOString(),
})

const harness = () => {
  let current = transaction()
  let swapped = false
  const release = vi.fn()
  const order: string[] = []
  const operations: ForwardSwapOperations = {
    read: () => current,
    isAlive: () => false,
    sides: () => swapped ? "swapped" : "not_swapped",
    lock: () => { order.push("lock"); return release },
    swap: () => { order.push("swap"); swapped = true },
    sync: () => { order.push("sync") },
    launch: async () => { order.push("launch"); return { pid: 102, start: "new-start" } },
    advance: (phase: Phase, patch = {}) => {
      order.push(`phase:${phase}`)
      current = { ...current, ...patch, phase, updated_at: new Date().toISOString() }
      return current
    },
  }
  return { current: () => current, operations, order, release, setCurrent: (tx: UpdateTransaction) => { current = tx } }
}

describe("watchdog forward swap", () => {
  it("intercambia bajo lock, verifica lados y registra la app nueva", async () => {
    const run = harness()

    const result = await performForwardSwap(transaction(), run.operations)

    expect(result).toMatchObject({ phase: "launched", new_app: { pid: 102, start: "new-start" } })
    expect(run.order).toEqual(["lock", "swap", "sync", "phase:swapped", "launch", "phase:launched"])
    expect(run.release).toHaveBeenCalledTimes(1)
  })

  it("no intercambia mientras la app vieja siga viva", async () => {
    const run = harness()
    run.operations.isAlive = () => true

    await expect(performForwardSwap(transaction(), run.operations)).rejects.toThrow("app vieja")
    expect(run.order).toEqual([])
  })

  it("revalida fase, identidad y lados después de tomar el lock", async () => {
    const run = harness()
    run.operations.lock = () => {
      run.setCurrent({ ...run.current(), phase: "ambiguous" })
      return run.release
    }

    await expect(performForwardSwap(transaction(), run.operations)).rejects.toThrow("cambió")
    expect(run.order).toEqual([])
    expect(run.release).toHaveBeenCalledTimes(1)
  })

  it("libera el lock si el helper falla y no registra swapped", async () => {
    const run = harness()
    run.operations.swap = () => { throw new Error("helper failed") }

    await expect(performForwardSwap(transaction(), run.operations)).rejects.toThrow("helper failed")
    expect(run.current().phase).toBe("swap_intent")
    expect(run.release).toHaveBeenCalledTimes(1)
  })
})
