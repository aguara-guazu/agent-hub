import { describe, expect, it, vi } from "vitest"
import { CoreDidNotExit, DrainClient, type DrainClientDeps } from "./update-lease.js"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
})

const client = (call: DrainClientDeps["call"], extra: Partial<DrainClientDeps> = {}) => {
  const log = vi.fn()
  const drain = new DrainClient({
    call,
    secret: "test-secret",
    log,
    core: { pid: 321, state: "running" },
    startTimeOf: async () => "start-321",
    ...extra,
  })
  return { drain, log }
}

describe("DrainClient", () => {
  it("admite el core nuevo usando el boot id observado en ese mismo proceso", async () => {
    const calls: Array<{ path: string; method: string; body?: string }> = []
    const { drain } = client(async (path, init) => {
      calls.push({ path, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) })
      if (path.endsWith("/status")) return json({ inflight: 0, draining: true, boot_id: "boot-current" })
      if (path === "/api/internal/update-admit") return json({ admitted: true })
      return json({}, 404)
    })

    expect(await drain.admitStartup("tx-12345678")).toBe(true)
    expect(calls).toEqual([
      { path: "/api/internal/update-drain/status", method: "GET" },
      { path: "/api/internal/update-admit", method: "POST", body: JSON.stringify({ transaction_id: "tx-12345678", boot_id: "boot-current" }) },
    ])
  })

  it("no admite cuando status o el ack no corresponden", async () => {
    const { drain: missingBoot } = client(async () => json({ draining: true }))
    expect(await missingBoot.admitStartup("tx-12345678")).toBe(false)

    const { drain: refused } = client(async (path) => path.endsWith("/status")
      ? json({ draining: true, boot_id: "boot-current" })
      : json({ admitted: false, reason: "transaction_mismatch" }, 409))
    expect(await refused.admitStartup("tx-12345678")).toBe(false)
  })

  it("cancela un drenaje pendiente sin lease y reporta reapertura no confirmada", async () => {
    const call = vi.fn(async () => json({ ok: true, reopened: true }))
    const { drain } = client(call)

    await drain.cancelPending()

    expect(call).toHaveBeenCalledWith("/api/internal/update-drain/pending/cancel", expect.objectContaining({ method: "POST" }))

    const failedCall = vi.fn(async () => json({ ok: true, reopened: false }))
    const { drain: failed, log } = client(failedCall)
    await failed.cancelPending()
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no confirmó la reapertura"))
  })

  it("nunca mata core cuando el commit no observa su salida", async () => {
    let now = 0
    const call = vi.fn(async (path: string) => path.endsWith("/confirm")
      ? json({ ok: true, remaining_ms: 120_000 })
      : json({ ok: true }))
    const { drain } = client(call, {
      now: () => now,
      sleep: async (ms: number) => { now += ms },
      exitWaitMs: 500,
    })

    await expect(drain.commit({ lease: "lease", generation: 1, bootId: "boot", deadline: 60_000 })).rejects.toBeInstanceOf(CoreDidNotExit)
    expect(call).toHaveBeenCalledTimes(2)
  })
})
