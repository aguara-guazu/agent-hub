import { randomBytes } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { check, parse } from "../contracts.js"
import type { MemoryDatabase } from "../database.js"
import type { SharedEvents } from "./events.js"

/**
 * Peer update hints ride the shared event log as `receipt` payloads whose `message` is outside the id space of real
 * messages (hex64 event ids). Every hub since 0.8.0 accepts receipts from any member, readers included, stores them and
 * only ever joins them against real message ids, so older hubs advance their cursor without side effects. No new
 * discriminant, frame or hello field is introduced. A hint carries no version, URL or digest: receivers only wake their
 * own check against the official release feed.
 */
export const UPDATE_HINT_PREFIX = "agenthub:update-hint:v1:"
const HINT = /^agenthub:update-hint:v1:[0-9a-f]{32}$/
const SETTING = "update_hint"
export const HINT_PER_AUTHOR_MS = 10 * 60_000
export const HINT_GLOBAL_MS = 60_000
const MAX_WAIT_MS = 25_000
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

interface HintState {
  generation: number
  received_at: string | null
  global_at: number
  authors: Record<string, number>
  announced: Record<string, string>
}
const stateSchema = z.object({
  generation: z.number().int().nonnegative(),
  received_at: z.string().nullable(),
  global_at: z.number().int().nonnegative(),
  authors: z.record(z.string(), z.number().int().nonnegative()),
  announced: z.record(z.string(), z.string().regex(SEMVER)),
}).strict()
const empty = (): HintState => ({ generation: 0, received_at: null, global_at: 0, authors: {}, announced: {} })

export function isUpdateHint(message: unknown): boolean { return typeof message === "string" && message.startsWith(UPDATE_HINT_PREFIX) }

export type HintLog = (line: string) => void

export class UpdateHints {
  private waiters = new Set<() => void>()
  private serial: Promise<unknown> = Promise.resolve()

  constructor(private readonly db: MemoryDatabase, private readonly sharing: SharedEvents, private readonly offer: () => Promise<void>,
    private readonly log: HintLog, private readonly now: () => number = Date.now) {}

  /** Serializes read-modify-write of the persisted limits so concurrent receipts cannot both pass a limit. */
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work, work)
    this.serial = next.catch(() => undefined)
    return next
  }
  private async read(): Promise<HintState> {
    const row = (await this.db.query<{ value: unknown }>("SELECT value FROM settings WHERE key=$1", [SETTING]))[0]
    if (!row) return empty()
    // A corrupt row must not reopen the limits; it fails closed and keeps the evidence until an operator clears it.
    return parse(stateSchema, row.value)
  }
  private async write(state: HintState) {
    await this.db.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [SETTING, JSON.stringify(state)])
  }

  /**
   * Called for every stored receipt. Own hints, malformed hints and hints over the per-author or global limit are
   * dropped; an accepted one bumps the generation that the desktop long-poll waits on.
   */
  observe(message: unknown, author: string): void {
    if (!isUpdateHint(message)) return
    void this.locked(async () => {
      if (!HINT.test(String(message))) { this.log(`[updater] pista P2P descartada: formato inválido (autor ${author.slice(0, 12)})`); return }
      if (author === (await this.sharing.identity()).id) return
      const state = await this.read(), now = this.now()
      if (now - (state.authors[author] ?? 0) < HINT_PER_AUTHOR_MS) { this.log(`[updater] pista P2P limitada: autor ${author.slice(0, 12)}`); return }
      if (now - state.global_at < HINT_GLOBAL_MS) { this.log("[updater] pista P2P limitada: límite global"); return }
      const authors = Object.fromEntries(Object.entries(state.authors).filter(([, at]) => now - at < HINT_PER_AUTHOR_MS))
      authors[author] = now
      await this.write({ ...state, generation: state.generation + 1, received_at: new Date(now).toISOString(), global_at: now, authors })
      this.log(`[updater] pista P2P recibida de ${author.slice(0, 12)}; se consultan los releases oficiales`)
      for (const wake of [...this.waiters]) wake()
    }).catch(error => this.log(`[updater] pista P2P no registrada: ${error instanceof Error ? error.message : "error"}`))
  }

  /** Resolves with the current generation once it is greater than `after`, or with null when `waitMs` elapses or `signal` aborts. */
  async wait(after: number, waitMs: number, signal?: AbortSignal): Promise<number | null> {
    const deadline = this.now() + Math.min(Math.max(waitMs, 0), MAX_WAIT_MS)
    for (;;) {
      const { generation } = await this.read()
      if (generation > after) return generation
      const left = deadline - this.now()
      if (left <= 0 || signal?.aborted) return null
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.waiters.delete(done); signal?.removeEventListener("abort", done); resolve() }
        const timer = setTimeout(done, left)
        this.waiters.add(done); signal?.addEventListener("abort", done, { once: true })
      })
    }
  }

  async generation() { return (await this.read()).generation }

  /**
   * Publishes one hint per shared project for `version`, at most once per project and version. Projects without access
   * are skipped. The network is then ticked so connected peers receive the receipt now instead of at the next interval.
   */
  async announce(version: string): Promise<{ announced: number; skipped: number }> {
    check(SEMVER.test(version), "Versión inválida")
    const result = await this.locked(async () => {
      const state = await this.read(), announced = { ...state.announced }
      const projects = await this.db.query<{ id: string }>("SELECT id FROM shared_projects WHERE enabled=1")
      let count = 0, skipped = 0
      for (const { id } of projects) {
        if (announced[id] === version) continue
        try {
          await this.sharing.append(id, { kind: "receipt", message: `${UPDATE_HINT_PREFIX}${randomBytes(16).toString("hex")}`, state: "read", agent: null })
          announced[id] = version; count++
          // Persist after each project: a crash mid-loop must not re-announce the ones already published.
          await this.write({ ...state, announced })
        } catch (error) {
          skipped++
          this.log(`[updater] pista P2P no publicada en ${id}: ${error instanceof Error ? error.message : "error"}`)
        }
      }
      return { announced: count, skipped }
    })
    if (result.announced) {
      this.log(`[updater] pista P2P publicada en ${result.announced} proyecto(s) para ${version}`)
      await this.offer().catch(() => undefined)
    }
    return result
  }
}

/**
 * Desktop-only routes. `authorize` must accept only the desktop update credential, never an owner token: a hint wakes a
 * network fetch and an announce writes to every shared log.
 */
export function registerUpdateHintRoutes(app: FastifyInstance, hints: () => Promise<UpdateHints>, authorize: (request: FastifyRequest) => Promise<void>) {
  app.get("/api/internal/update-hint", async (request, reply) => {
    await authorize(request)
    const query = parse(z.object({ after: z.coerce.number().int().nonnegative().default(0), wait: z.coerce.number().int().min(0).max(MAX_WAIT_MS).default(0) }), request.query)
    const abort = new AbortController()
    request.raw.once("close", () => abort.abort())
    const generation = await (await hints()).wait(query.after, query.wait, abort.signal)
    if (generation === null) return reply.code(204).send()
    return { generation }
  })
  app.post("/api/internal/update-hint/announce", { bodyLimit: 1024 }, async request => {
    await authorize(request)
    const body = parse(z.object({ version: z.string().regex(SEMVER) }).strict(), request.body)
    return (await hints()).announce(body.version)
  })
}
