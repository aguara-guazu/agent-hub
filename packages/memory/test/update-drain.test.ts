import { describe, expect, it, vi } from "vitest"
import { UpdateDrain, type AdmissionGateLike } from "../src/update-drain.js"

class Gate implements AdmissionGateLike {
  closed = false
  closes = 0
  reopens = 0
  private token: symbol | null = null

  close(): symbol {
    if (this.closed) throw Object.assign(new Error("already closed"), { code: "already_draining" })
    this.closed = true
    this.closes++
    this.token = Symbol("gate")
    return this.token
  }

  async reopenConfirmed(token: symbol): Promise<boolean> {
    if (token !== this.token) return false
    this.closed = false
    this.reopens++
    this.token = null
    return true
  }
}

const makeDrain = (counts: { fleet_live: number; jobs_nonresumable: number }, ttlMs = 600_000) => {
  const gate = new Gate()
  const blockers = vi.fn(async () => ({ ...counts }))
  const drain = new UpdateDrain({
    gate: () => gate,
    nonMcpBlockers: () => blockers,
    legacyGateways: async () => ({ count: 0, not_applicable: true }),
  }, ttlMs)
  return { gate, blockers, drain }
}

describe("UpdateDrain convergente", () => {
  it("mantiene cerradas las admisiones mientras termina la flota y concede el mismo intento al quedar en cero", async () => {
    const counts = { fleet_live: 1, jobs_nonresumable: 0 }
    const { gate, drain } = makeDrain(counts)

    expect(await drain.acquire()).toEqual({ ok: false, reasons: [{ code: "fleet_live", count: 1 }] })
    expect(drain.isDraining).toBe(true)
    expect(gate.closed).toBe(true)
    expect(gate.closes).toBe(1)
    expect(drain.admit()).toBe(false)

    counts.fleet_live = 0
    const granted = await drain.acquire()
    expect(granted).toMatchObject({ ok: true, generation: 1, boot_id: drain.bootId })
    expect(gate.closes).toBe(1)
    expect(gate.reopens).toBe(0)
  })

  it("cancela un intento pendiente y confirma la reapertura", async () => {
    const counts = { fleet_live: 1, jobs_nonresumable: 0 }
    const { gate, drain } = makeDrain(counts)

    await drain.acquire()
    expect(await drain.cancelPending()).toEqual({ ok: true, reopened: true })
    expect(drain.isDraining).toBe(false)
    expect(gate.closed).toBe(false)
    expect(gate.reopens).toBe(1)
    expect(drain.admit()).toBe(true)
  })

  it("libera un intento pendiente al vencer para no dejar el Hub cerrado", async () => {
    vi.useFakeTimers()
    try {
      const counts = { fleet_live: 1, jobs_nonresumable: 0 }
      const { gate, drain } = makeDrain(counts, 1_000)

      await drain.acquire()
      expect(drain.isDraining).toBe(true)
      expect(gate.closed).toBe(true)
      await vi.advanceTimersByTimeAsync(1_001)

      expect(drain.isDraining).toBe(false)
      expect(gate.closed).toBe(false)
      expect(gate.reopens).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("no conserva el cierre cuando los bloqueos son desconocidos o externos", async () => {
    const gate = new Gate()
    const drain = new UpdateDrain({
      gate: () => gate,
      nonMcpBlockers: () => async () => ({ fleet_live: 0, jobs_nonresumable: 0 }),
      legacyGateways: async () => ({ count: 1 }),
    })

    expect(await drain.acquire()).toEqual({ ok: false, reasons: [{ code: "legacy_gateways", count: 1 }] })
    expect(drain.isDraining).toBe(false)
    expect(gate.closed).toBe(false)
  })

  it("admite el core nuevo solo para la transacción y boot correctos", async () => {
    const counts = { fleet_live: 0, jobs_nonresumable: 0 }
    const { gate, drain } = makeDrain(counts)

    drain.beginStartup("tx-12345678")
    expect(drain.isDraining).toBe(true)
    expect(await drain.admitStartup("tx-otra-123", drain.bootId)).toEqual({ ok: false, reason: "transaction_mismatch" })
    expect(await drain.admitStartup("tx-12345678", "otro-boot")).toEqual({ ok: false, reason: "boot_mismatch" })
    expect(await drain.admitStartup("tx-12345678", drain.bootId)).toEqual({ ok: true })
    expect(gate.closed).toBe(false)
    expect(drain.isDraining).toBe(false)
  })
})
