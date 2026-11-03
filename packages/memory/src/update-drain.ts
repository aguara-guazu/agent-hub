import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { check, parse } from './contracts.js'
import type { MemoryService } from './service.js'

/** The MCP upstream used by every gateway; the only admission the update gate counts and refuses. */
const MCP_PATH = '/api/memory/mcp'
/** A lease nobody cancels or consumes frees core on its own, so a desktop that vanished cannot leave it refusing calls. */
const LEASE_TTL_MS = 10 * 60_000

export interface DrainReason { code: string; count?: number }
export type DrainResult = { ok: true; lease: string; generation: number } | { ok: false; reasons: DrainReason[] }

/**
 * Atomic admission gate for a silent update. `acquire` either returns stable reasons at once (nothing is
 * waited on, no HTTP request stays open) or leaves core refusing new MCP admissions with `503` +
 * `x-agenthub-draining` before any handler runs. Core is then idle: there was no MCP call in flight when
 * the lease was granted and none can start while it is held.
 */
export class UpdateDrain {
  private inflight = 0
  private draining = false
  private acquiring = false
  private lease: string | null = null
  private generation = 0
  private expiry: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly blockers: () => Promise<DrainReason[]>) {}

  get isDraining(): boolean { return this.draining }
  get inflightCount(): number { return this.inflight }

  /** `false` while draining: the caller answers 503 without running anything. */
  admit(): boolean {
    if (this.draining) return false
    this.inflight++
    return true
  }

  leave(): void {
    if (this.inflight > 0) this.inflight--
  }

  async acquire(): Promise<DrainResult> {
    if (this.lease || this.acquiring) return { ok: false, reasons: [{ code: 'drain_in_progress' }] }
    this.acquiring = true
    // Refuse new admissions first; then every blocker is read with nothing new entering behind it.
    this.draining = true
    try {
      const reasons = await this.blockers()
      // In-flight is read last and synchronously with the grant: it can only have fallen since draining began.
      if (this.inflight > 0) reasons.push({ code: 'inflight_mcp', count: this.inflight })
      if (reasons.length > 0) { this.draining = false; return { ok: false, reasons } }
      this.lease = randomUUID()
      this.generation++
      clearTimeout(this.expiry)
      this.expiry = setTimeout(() => this.release(), LEASE_TTL_MS)
      this.expiry.unref()
      return { ok: true, lease: this.lease, generation: this.generation }
    } catch {
      this.draining = false
      return { ok: false, reasons: [{ code: 'core_unreachable' }] }
    } finally {
      this.acquiring = false
    }
  }

  cancel(lease: string, generation: number): boolean {
    if (!this.lease || this.lease !== lease || this.generation !== generation) return false
    this.release()
    return true
  }

  private release(): void {
    clearTimeout(this.expiry)
    this.lease = null
    this.draining = false
  }
}

/** Work that would be lost or repeated if core stopped now: live Hub workers and running jobs or schedule runs. */
export function updateBlockers(service: MemoryService): () => Promise<DrainReason[]> {
  return async () => {
    const reasons: DrainReason[] = []
    const live = await service.fleetLiveCount()
    if (live > 0) reasons.push({ code: 'fleet_live', count: live })
    const { db } = await service.get()
    const count = async (sql: string) => Number((await db.query<{ n: number | string }>(sql))[0]?.n ?? 0)
    const jobs = await count("SELECT COUNT(*) AS n FROM jobs WHERE state='running' AND lease_until>now()")
    const runs = await count("SELECT COUNT(*) AS n FROM schedule_runs WHERE state='running'")
    if (jobs + runs > 0) reasons.push({ code: 'unresumable_work', count: jobs + runs })
    return reasons
  }
}

/** Gate hook and routes; call before the MCP route is registered so the hook covers it. */
export function registerUpdateDrain(app: FastifyInstance, service: MemoryService, authorize: (request: FastifyRequest) => Promise<unknown>): UpdateDrain {
  const drain = new UpdateDrain(updateBlockers(service))
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0] !== MCP_PATH) return
    if (!drain.admit()) {
      return reply.code(503).header('x-agenthub-draining', '1').header('retry-after', '2').send({ detail: 'Agent Hub se está actualizando; reintente en unos segundos' })
    }
    let left = false
    const leave = () => { if (!left) { left = true; drain.leave() } }
    reply.raw.once('close', leave)
    reply.raw.once('finish', leave)
  })
  app.post('/api/internal/update-drain', { preHandler: async request => { await authorize(request) } }, async (request, reply) => {
    const result = await drain.acquire()
    return result.ok ? result : reply.code(409).send(result)
  })
  app.post('/api/internal/update-drain/cancel', { preHandler: async request => { await authorize(request) } }, async request => {
    const input = parse(z.object({ lease: z.string().min(1).max(100), generation: z.number().int().nonnegative() }).strict(), request.body)
    check(drain.cancel(input.lease, input.generation), 'El drenaje no corresponde a este lease', 409)
    return { ok: true }
  })
  return drain
}
