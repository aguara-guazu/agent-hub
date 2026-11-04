import { describe, expect, it, vi } from "vitest"
import { UpdateDrain, type AdmissionGateLike } from "../src/update-drain.js"

class Gate implements AdmissionGateLike {
  closed = false
  closes = 0
  reopens = 0
  reopenCalls = 0
  private token: symbol | null = null

  close(): symbol {
    if (this.closed) throw Object.assign(new Error("already closed"), { code: "already_draining" })
    this.closed = true
    this.closes++
    this.token = Symbol("gate")
    return this.token
  }

  async reopenConfirmed(token: symbol): Promise<boolean> {
    this.reopenCalls++
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

  it("usa la misma compuerta para el cierre manual y espera todo el trabajo protegido", async () => {
    const counts = { fleet_live: 2, jobs_nonresumable: 1 }
    const { gate, drain } = makeDrain(counts)

    expect(await drain.beginShutdown()).toMatchObject({ inflight: 0, fleet_live: 2, jobs_nonresumable: 1, blockers_known: true })
    expect(drain.isDraining).toBe(true)
    expect(gate.closed).toBe(true)
    expect(drain.admit()).toBe(false)

    counts.fleet_live = 0
    counts.jobs_nonresumable = 0
    expect(await drain.shutdownStatus()).toMatchObject({ inflight: 0, fleet_live: 0, jobs_nonresumable: 0, blockers_known: true })

    expect(await drain.endShutdown()).toMatchObject({ draining: false })
    expect(gate.closed).toBe(false)
  })

  it("adopta un intento pendiente para shutdown y lo reabre al cancelar el cierre", async () => {
    const counts = { fleet_live: 1, jobs_nonresumable: 0 }
    const { gate, drain } = makeDrain(counts)

    await drain.acquire()
    await drain.beginShutdown()
    await drain.endShutdown()

    expect(drain.isDraining).toBe(false)
    expect(gate.closed).toBe(false)
  })

  it("reabre una sola vez si se cancela mientras el conteo sigue en curso", async () => {
    const gate = new Gate()
    let resolve!: (value: { fleet_live: number; jobs_nonresumable: number }) => void
    const blockers = new Promise<{ fleet_live: number; jobs_nonresumable: number }>(done => { resolve = done })
    const drain = new UpdateDrain({
      gate: () => gate,
      nonMcpBlockers: () => () => blockers,
      legacyGateways: async () => ({ count: 0, not_applicable: true }),
    })

    const acquiring = drain.acquire()
    await Promise.resolve()
    expect(await drain.cancelPending()).toEqual({ ok: true, reopened: true })
    resolve({ fleet_live: 0, jobs_nonresumable: 0 })

    expect(await acquiring).toEqual({ ok: false, reasons: [{ code: "already_draining" }] })
    expect(gate.reopenCalls).toBe(1)
  })

  it("no concede un lease con menos margen que el cliente acepta", async () => {
    let now = 0
    const counts = { fleet_live: 1, jobs_nonresumable: 0 }
    const gate = new Gate()
    const drain = new UpdateDrain({
      gate: () => gate,
      nonMcpBlockers: () => async () => ({ ...counts }),
      legacyGateways: async () => ({ count: 0, not_applicable: true }),
    }, 120_000, () => now)

    await drain.acquire()
    now = 61_000
    counts.fleet_live = 0

    expect(await drain.acquire()).toEqual({ ok: false, reasons: [{ code: "already_draining" }] })
    expect(gate.closed).toBe(false)
  })

  it("admite el core nuevo solo para la transacción y boot correctos", async () => {
    const counts = { fleet_live: 0, jobs_nonresumable: 0 }
    const { gate, drain } = makeDrain(counts)

    drain.beginStartup("tx-12345678")
    expect(drain.isDraining).toBe(true)
    expect(drain.status()).toMatchObject({ startup_transaction: "tx-12345678", admitted_transaction: null })
    expect(await drain.admitStartup("tx-otra-123", drain.bootId)).toEqual({ ok: false, reason: "transaction_mismatch" })
    expect(await drain.admitStartup("tx-12345678", "otro-boot")).toEqual({ ok: false, reason: "boot_mismatch" })
    expect(await drain.admitStartup("tx-12345678", drain.bootId)).toEqual({ ok: true })
    expect(drain.status()).toMatchObject({ startup_transaction: null, admitted_transaction: "tx-12345678" })
    expect(gate.closed).toBe(false)
    expect(drain.isDraining).toBe(false)
  })
})
