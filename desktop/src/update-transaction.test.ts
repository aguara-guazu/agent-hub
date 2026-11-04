import { afterEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { advancePhase, canAdvance, healthyFile, journalFile, readTransaction, writeJsonDurable, type UpdateTransaction } from "./update-transaction.js"
import { recoverTransaction } from "./update-recovery.js"

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

const bundle = async (path: string, version: string) => {
  const contents = join(path, "Contents")
  await mkdir(contents, { recursive: true })
  await writeFile(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`)
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("transacción del updater", () => {
  it("solo admite transiciones consecutivas o terminales", () => {
    expect(canAdvance("staged", "watchdog_ready")).toBe(true)
    expect(canAdvance("watchdog_ready", "swap_intent")).toBe(true)
    expect(canAdvance("swap_intent", "swapped")).toBe(true)
    expect(canAdvance("swapped", "launched")).toBe(true)
    expect(canAdvance("launched", "admitting")).toBe(true)
    expect(canAdvance("admitting", "admitted")).toBe(true)
    expect(canAdvance("admitted", "healthy")).toBe(true)
    expect(canAdvance("launched", "healthy")).toBe(false)
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
    advancePhase(dir, tx.transaction_id, "admitting")
    advancePhase(dir, tx.transaction_id, "admitted")

    expect(readTransaction(dir)).toMatchObject({ kind: "ok", tx: { phase: "admitted", new_app: { pid: 102, start: "new-start" } } })
  })

  it("distingue una transacción aplicada cuyo watchdog murió", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenthub-update-watchdog-loss-"))
    paths.push(dir)
    const tx = { ...transaction(dir), phase: "launched" as const, new_app: { pid: 102, start: "new-start" } }
    await bundle(tx.paths.installed, tx.to.version)
    await bundle(tx.paths.incoming, tx.from.version)
    writeJsonDurable(journalFile(dir), tx)

    const base = {
      stateDir: dir,
      updateDir: dir,
      installed: tx.paths.installed,
      version: tx.to.version,
      removeTree: (path: string) => rm(path, { recursive: true, force: true }),
      log: () => undefined,
    }
    expect(await recoverTransaction({ ...base, isAlive: () => false })).toBe("monitor_without_watchdog")
    expect(await recoverTransaction({ ...base, isAlive: () => true })).toBe("monitor")
  })

  it.each(["healthy", "done"] as const)("recupera la fase %s si el respaldo ya fue descartado", async phase => {
    const dir = await mkdtemp(join(tmpdir(), "agenthub-update-cleanup-"))
    paths.push(dir)
    const tx = { ...transaction(dir), phase }
    await bundle(tx.paths.installed, tx.to.version)
    writeJsonDurable(journalFile(dir), tx)
    writeJsonDurable(healthyFile(dir, tx.transaction_id), {
      transaction_id: tx.transaction_id,
      version: tx.to.version,
      at: new Date().toISOString(),
    })

    const result = await recoverTransaction({
      stateDir: dir,
      updateDir: dir,
      installed: tx.paths.installed,
      version: tx.to.version,
      removeTree: path => rm(path, { recursive: true, force: true }),
      isAlive: () => false,
      log: () => undefined,
    })

    expect(result).toBe("cleaned")
    expect(readTransaction(dir)).toEqual({ kind: "missing" })
  })
})
