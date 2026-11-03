import { createHash } from "node:crypto"
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

const stateSchema = z.object({
  generation: z.number().int().nonnegative(),
  received_at: z.string().nullable(),
  global_at: z.number().int().nonnegative(),
  authors: z.record(z.string(), z.number().int().nonnegative()),
  announced: z.record(z.string(), z.string().regex(SEMVER)),
  /** Highest version this hub ever announced; a lower one is never announced again. */
  last_version: z.string().regex(SEMVER).nullable(),
  /** shared_events.seq up to which hint receipts were evaluated; receipts above it are replayed after a crash. */
  seen_seq: z.number().int().nonnegative(),
}).strict()
type HintState = z.infer<typeof stateSchema>

export function isUpdateHint(message: unknown): boolean { return typeof message === "string" && message.startsWith(UPDATE_HINT_PREFIX) }

function semverParts(version: string) { return version.split(".").map(part => Number(part)) as [number, number, number] }
function compareSemver(a: string, b: string) {
  const [x, y] = [semverParts(a), semverParts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1
  return 0
}

export type HintLog = (line: string) => void

export class UpdateHints {
  private waiters = new Set<() => void>()
  private serial: Promise<unknown> = Promise.resolve()

  constructor(private readonly db: MemoryDatabase, private readonly sharing: SharedEvents, private readonly offer: () => Promise<void>,
    private readonly log: HintLog, private readonly now: () => number = Date.now) {}

  /** Serializes read-modify-write of the persisted state so concurrent receipts cannot both pass a limit. */
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work, work)
    this.serial = next.catch(() => undefined)
    return next
  }
  private async maxSeq() {
    return Number((await this.db.query<{ seq: number }>("SELECT COALESCE(max(seq),0) AS seq FROM shared_events"))[0]?.seq ?? 0)
  }
  private async read(): Promise<HintState> {
    const row = (await this.db.query<{ value: unknown }>("SELECT value FROM settings WHERE key=$1", [SETTING]))[0]
    // First run replays stored hints from the start: at worst one extra check of the official feed, never a lost hint.
    if (!row) return { generation: 0, received_at: null, global_at: 0, authors: {}, announced: {}, last_version: null, seen_seq: 0 }
    // A corrupt row must not reopen the limits; it fails closed and keeps the evidence until an operator clears it.
    return parse(stateSchema, row.value)
  }
  private async write(state: HintState) {
    await this.db.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [SETTING, JSON.stringify(state)])
  }
  private wakeAll() { for (const wake of [...this.waiters]) wake() }

  /**
   * Evaluates every hint receipt stored after `seen_seq`, in log order, and advances `seen_seq` in the same write.
   * Called after each stored receipt and once at start-up, so a crash between storing a receipt and evaluating it only
   * delays the hint. Own and malformed hints are dropped; the per-author and global limits use the evaluation time.
   */
  sweep(): Promise<void> {
    return this.locked(async () => {
      const state = await this.read()
      const rows = await this.db.query<{ seq: number; message: string; author: string }>(`SELECT seq, payload->>'message' AS message, document->>'author' AS author
        FROM shared_events WHERE seq>$1 AND payload->>'kind'='receipt' AND payload->>'message' LIKE 'agenthub:update-hint:%' ORDER BY seq`, [state.seen_seq])
      const head = await this.maxSeq()
      if (!rows.length) { if (head !== state.seen_seq) await this.write({ ...state, seen_seq: head }); return }
      const own = (await this.sharing.identity()).id, now = this.now()
      let next = state, accepted = 0
      for (const row of rows) {
        if (row.author === own) continue
        if (!HINT.test(row.message)) { this.log(`[updater] pista P2P descartada: formato inválido (autor ${row.author.slice(0, 12)})`); continue }
        if (now - (next.authors[row.author] ?? 0) < HINT_PER_AUTHOR_MS) { this.log(`[updater] pista P2P limitada: autor ${row.author.slice(0, 12)}`); continue }
        if (now - next.global_at < HINT_GLOBAL_MS) { this.log("[updater] pista P2P limitada: límite global"); continue }
        const authors = Object.fromEntries(Object.entries(next.authors).filter(([, at]) => now - at < HINT_PER_AUTHOR_MS))
        authors[row.author] = now
        next = { ...next, generation: next.generation + 1, received_at: new Date(now).toISOString(), global_at: now, authors }
        accepted++
        this.log(`[updater] pista P2P recibida de ${row.author.slice(0, 12)}; se consultan los releases oficiales`)
      }
      await this.write({ ...next, seen_seq: Math.max(head, rows.at(-1)!.seq) })
      if (accepted) this.wakeAll()
    })
  }

  /** Receipt observer: cheap prefix filter, then a serialized sweep from the durable cursor. */
  observe(message: unknown): void {
    if (!isUpdateHint(message)) return
    void this.sweep().catch(error => this.log(`[updater] pista P2P no evaluada: ${error instanceof Error ? error.message : "error"}`))
  }

  /**
   * Resolves with the current generation once it is greater than `after`, or with null when `waitMs` elapses or
   * `signal` aborts. The waiter is registered before each read so a hint accepted in between is never missed.
   */
  async wait(after: number, waitMs: number, signal?: AbortSignal): Promise<number | null> {
    const deadline = this.now() + Math.min(Math.max(waitMs, 0), MAX_WAIT_MS)
    for (;;) {
      let wake!: () => void
      const woken = new Promise<void>(resolve => { wake = resolve })
      this.waiters.add(wake)
      try {
        const { generation } = await this.read()
        if (generation > after) return generation
        const left = deadline - this.now()
        if (left <= 0 || signal?.aborted) return null
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([woken, new Promise<void>(resolve => {
          timer = setTimeout(resolve, left)
          signal?.addEventListener("abort", () => resolve(), { once: true })
        })])
        clearTimeout(timer)
      } finally { this.waiters.delete(wake) }
    }
  }

  async generation() { return (await this.read()).generation }

  /**
   * Publishes one hint per shared project for `version`. The nonce is derived from (hub identity, project, version), so a
   * crash between appending and persisting is detected by looking the receipt up instead of publishing a second one.
   * A version lower than the highest one ever announced is refused. Projects without access are skipped. The network is
   * then ticked so connected peers are offered the new head now instead of at the next interval.
   */
  async announce(version: string): Promise<{ announced: number; skipped: number }> {
    check(SEMVER.test(version), "Versión inválida")
    const result = await this.locked(async () => {
      let state = await this.read()
      check(!state.last_version || compareSemver(version, state.last_version) >= 0, "No se anuncia una versión menor que la ya anunciada", 409)
      state = { ...state, last_version: version }
      const own = (await this.sharing.identity()).id
      const projects = await this.db.query<{ id: string }>("SELECT id FROM shared_projects WHERE enabled=1")
      let count = 0, skipped = 0
      for (const { id } of projects) {
        if (state.announced[id] === version) continue
        const nonce = createHash("sha256").update(`${own}\n${id}\n${version}`).digest("hex").slice(0, 32)
        const message = `${UPDATE_HINT_PREFIX}${nonce}`
        try {
          const existing = await this.db.query("SELECT id FROM shared_events WHERE project_id=$1 AND payload->>'kind'='receipt' AND payload->>'message'=$2 AND document->>'author'=$3 LIMIT 1", [id, message, own])
          if (!existing.length) { await this.sharing.append(id, { kind: "receipt", message, state: "read", agent: null }); count++ }
          state = { ...state, announced: { ...state.announced, [id]: version } }
          await this.write(state)
        } catch (error) {
          skipped++
          this.log(`[updater] pista P2P no publicada en ${id}: ${error instanceof Error ? error.message : "error"}`)
        }
      }
      await this.write(state)
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
    // The response stream closes before it is written only when the client goes away; the request stream may close as
    // soon as its (empty) body is consumed, which would turn every long-poll into an immediate 204.
    const onClose = () => { if (!reply.raw.writableEnded) abort.abort() }
    reply.raw.once("close", onClose)
    try {
      const generation = await (await hints()).wait(query.after, query.wait, abort.signal)
      if (generation === null) return reply.code(204).send()
      return { generation }
    } finally { reply.raw.off("close", onClose) }
  })
  app.post("/api/internal/update-hint/announce", { bodyLimit: 1024 }, async request => {
    await authorize(request)
    const body = parse(z.object({ version: z.string().regex(SEMVER) }).strict(), request.body)
    return (await hints()).announce(body.version)
  })
}
