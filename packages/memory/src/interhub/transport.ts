import { randomBytes, randomUUID } from "node:crypto"
import type { EventEmitter } from "node:events"
import { z } from "zod"
import type { InterhubChatPayload } from "@agenthub/shared"
import { check, MemoryError, parse } from "../contracts.js"
import type { MemoryStore } from "../store.js"
import type { NetworkExtension, NetworkPeer, NetworkTopic, SharedNetwork } from "../sharing/network.js"
import { digest, publicIdentity } from "../sharing/crypto.js"
import { sessionStatus } from "../local-chat.js"
import type { InterhubChat } from "./chat.js"
import { InterhubNetwork, channelTopic, chatKind, codeKey, joinProof, rendezvousTopic, rosterSchema, sameProof, type JoinTranscript, type VerifiedEnvelope } from "./network.js"

const joinTimeout = () => process.env.NODE_ENV === "test" && process.env.AGENTHUB_INTERHUB_JOIN_MS ? Number(process.env.AGENTHUB_INTERHUB_JOIN_MS) : 45_000
const PAGE_EVENTS = 50, PAGE_BYTES = 1_000_000
const MAX_APPLY_ATTEMPTS = 20
const JOIN_ATTEMPTS_PER_MINUTE = 10, JOIN_ATTEMPTS_PER_CONNECTION = 20
const REMOTE_CHANNELS_PER_PEER = 512
/** Same answer for a wrong, revoked or unknown code and for an unreachable creator hub. */
export const INVALID_CODE = "Código inválido o revocado, o el hub que creó el canal no está conectado."
const FRAME_LIMITS: Record<string, number> = { ih_join: 4_096, ih_join_result: 262_144, ih_have: 1_024, ih_pull: 1_024, ih_page: 2_000_000 }
const remoteSession = /^interhub:[a-f0-9]{64}:(.+)$/

const uuid = z.string().uuid(), seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const joinFrame = z.object({ type: z.literal("ih_join"), request: uuid, nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), proof: z.string().regex(/^[a-f0-9]{64}$/),
  leader: z.object({ id: z.string().min(1).max(200), label: z.string().min(1).max(200) }).strict() }).strict()
const joinResultFrame = z.union([
  z.object({ type: z.literal("ih_join_result"), request: uuid, ok: z.literal(false) }).strict(),
  z.object({ type: z.literal("ih_join_result"), request: uuid, ok: z.literal(true), proof: z.string().regex(/^[a-f0-9]{64}$/), roster: rosterSchema }).strict(),
])
const haveFrame = z.object({ type: z.literal("ih_have"), channel_id: uuid, last: seq }).strict()
const pullFrame = z.object({ type: z.literal("ih_pull"), channel_id: uuid, after: seq }).strict()
const pageFrame = z.object({ type: z.literal("ih_page"), channel_id: uuid, cursor: seq, last: seq,
  events: z.array(z.object({ seq: seq, envelope: z.unknown() }).strict()).max(PAGE_EVENTS) }).strict()

interface PeerState { pulling: Set<string>; announced: Map<string, number>; remote: Map<string, number>; joinAttempts: number }
interface PendingJoin {
  topic: string; key: string; caller: { id: string; label: string }; attempted: WeakSet<NetworkPeer>
  requests: Map<string, { peer: NetworkPeer; transcript: JoinTranscript }>; settle: (error: unknown, value?: { channel_id: string; hub_id: string }) => void
}
const iso = (value: unknown) => new Date(String(value)).toISOString()
const reason = (error: unknown) => error instanceof MemoryError ? error.message : "Error interno al aplicar un evento inter-hub"

/**
 * Inter-hub protocol multiplexed on the sharing P2P connections (Hyperswarm, Noise, signed hello).
 *
 * Topology: every member hub joins the channel topic, so members form a mesh; each hub also keeps the full signed log of
 * the channel and serves it to any member, so an event reaches a hub through whichever member it is connected to
 * (store-and-forward relay). Origin signatures are checked against the creator-admitted membership, so relaying never
 * lets the delivering peer change who an event comes from.
 */
export class InterhubTransport implements NetworkExtension {
  private readonly states = new WeakMap<NetworkPeer, PeerState>()
  private readonly cursors = new Map<string, number>()
  private readonly joins = new Map<string, PendingJoin>()
  private readonly attempts = new Map<string, number[]>()
  private readonly touched = new Map<string, number>()
  private flushing: Promise<void> | null = null
  private flushAgain = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private localId: string | null = null
  lastError: string | null = null

  constructor(readonly store: MemoryStore, readonly network: InterhubNetwork, readonly shared: SharedNetwork, readonly chat: InterhubChat, private readonly events?: EventEmitter) {
    shared.attach(this)
    events?.on("change", () => this.scheduleFlush())
  }

  private async local() { return this.localId ??= (await this.network.localIdentity()).id }
  private state(peer: NetworkPeer) {
    let state = this.states.get(peer)
    if (!state) this.states.set(peer, state = { pulling: new Set(), announced: new Map(), remote: new Map(), joinAttempts: 0 })
    return state
  }

  async topics(): Promise<NetworkTopic[]> {
    const topics = new Map<string, NetworkTopic>(), local = await this.local()
    const connected = new Set(this.shared.peers().map(peer => peer.identity.id))
    for (const channel of await this.network.memberChannels()) {
      const missing = (await this.network.activeMembers(channel.channel_id)).some(hub => hub !== local && !connected.has(hub))
      const topic = channelTopic(channel.channel_id)
      topics.set(topic, { topic, server: true, client: true, refreshMs: missing ? 30_000 : 0 })
    }
    for (const active of await this.network.activeCodes()) {
      const topic = rendezvousTopic(active.code)
      topics.set(topic, { topic, server: true, client: false, refreshMs: 0 })
    }
    for (const join of this.joins.values()) if (!topics.has(join.topic)) topics.set(join.topic, { topic: join.topic, server: false, client: true, refreshMs: 3_000 })
    return [...topics.values()]
  }

  async connected(peer: NetworkPeer) {
    this.state(peer)
    await this.touch(peer)
    await this.announce(peer)
    this.tryJoins()
  }

  disconnected(peer: NetworkPeer) {
    for (const join of this.joins.values()) for (const [request, pending] of join.requests) if (pending.peer === peer) join.requests.delete(request)
  }

  async tick(peers: NetworkPeer[]) {
    for (const peer of peers) {
      await this.touch(peer)
      await this.announce(peer)
      for (const channelId of this.state(peer).remote.keys()) await this.pull(peer, channelId)
    }
    await this.flushOutbox()
    await this.retryPending()
    this.tryJoins()
  }

  async frame(peer: NetworkPeer, frame: Record<string, unknown>, bytes: number) {
    const type = String(frame.type), limit = FRAME_LIMITS[type]
    // Unknown or oversized frames are protocol violations: the network layer closes the connection.
    check(limit && bytes <= limit, "Mensaje inter-hub inválido")
    if (type === "ih_join") return this.onJoin(peer, parse(joinFrame, frame))
    if (type === "ih_join_result") return this.onJoinResult(peer, parse(joinResultFrame, frame))
    await this.touch(peer)
    if (type === "ih_have") {
      const have = parse(haveFrame, frame), state = this.state(peer)
      if (!state.remote.has(have.channel_id) && state.remote.size >= REMOTE_CHANNELS_PER_PEER) return
      state.remote.set(have.channel_id, have.last)
      return this.pull(peer, have.channel_id)
    }
    if (type === "ih_pull") return this.onPull(peer, parse(pullFrame, frame))
    return this.onPage(peer, parse(pageFrame, frame))
  }

  /** Signs, logs and announces a chat event produced by this hub. */
  async publish(channelId: string, payload: InterhubChatPayload, agentId: string | null = null) {
    await this.network.append(channelId, chatKind(payload), payload, agentId)
    this.announceSoon(channelId)
  }

  /** Informs members of a code change and moves the rendezvous announcement to the new code (or drops it). */
  async codeChanged(channelId: string, action: "revoked" | "regenerated", generation: number) {
    await this.network.append(channelId, "code", { action, generation })
    this.announceSoon(channelId)
    await this.shared.refresh()
  }

  topicsChanged() { void this.shared.refresh().catch(() => {}) }

  /** Joiner side: finds the creator through the code's rendezvous topic and proves the code without sending it. */
  async join(caller: { id: string; label: string }, code: string) {
    check(code.length >= 32 && code.length <= 200, INVALID_CODE, 404)
    await this.network.assertNotOwnCode(code)
    const topic = rendezvousTopic(code)
    check(!this.joins.has(topic), "Ya hay una unión en curso con ese código; esperá su resultado.", 409)
    let timer: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined
    try {
      return await new Promise<{ channel_id: string; hub_id: string }>((resolve, reject) => {
        let settled = false
        this.joins.set(topic, { topic, key: codeKey(code), caller, attempted: new WeakSet(), requests: new Map(),
          settle: (error, value) => { if (settled) return; settled = true; if (error) reject(error); else resolve(value!) } })
        timer = setTimeout(() => this.joins.get(topic)?.settle(new MemoryError(404, INVALID_CODE)), joinTimeout())
        // The rendezvous lookup is repeated every few seconds instead of waiting for the 10 s network tick.
        let polls = 0
        poll = setInterval(() => { if (++polls % 6 === 0) void this.shared.refresh().catch(() => {}); this.tryJoins() }, 500)
        void this.shared.refresh().then(() => this.tryJoins()).catch(() => {})
      })
    } finally {
      clearTimeout(timer); clearInterval(poll)
      this.joins.delete(topic)
      this.topicsChanged()
    }
  }

  private tryJoins() {
    if (!this.joins.size) return
    void (async () => {
      const local = await this.local()
      for (const join of this.joins.values()) for (const peer of this.shared.peers()) {
        if (join.attempted.has(peer) || !peer.topics().includes(join.topic)) continue
        join.attempted.add(peer)
        const request = randomUUID(), nonce = randomBytes(32).toString("base64url")
        const transcript: JoinTranscript = { request, nonce, joiner: local, creator: peer.identity.id, joiner_noise: peer.localNoise, creator_noise: peer.remoteNoise }
        join.requests.set(request, { peer, transcript })
        await peer.send({ type: "ih_join", request, nonce, proof: joinProof(join.key, "join", transcript), leader: join.caller }).catch(() => join.requests.delete(request))
      }
    })().catch(() => {})
  }

  private async onJoin(peer: NetworkPeer, request: z.infer<typeof joinFrame>) {
    const state = this.state(peer), now = Date.now()
    if (this.attempts.size > 1_000) for (const [id, times] of this.attempts) if (times.every(at => now - at >= 60_000)) this.attempts.delete(id)
    const recent = (this.attempts.get(peer.identity.id) ?? []).filter(at => now - at < 60_000)
    recent.push(now); this.attempts.set(peer.identity.id, recent)
    const refuse = () => peer.send({ type: "ih_join_result", request: request.request, ok: false })
    if (++state.joinAttempts > JOIN_ATTEMPTS_PER_CONNECTION || recent.length > JOIN_ATTEMPTS_PER_MINUTE) return refuse()
    const transcript: JoinTranscript = { request: request.request, nonce: request.nonce, joiner: peer.identity.id, creator: await this.local(),
      joiner_noise: peer.remoteNoise, creator_noise: peer.localNoise }
    const admitted = await this.network.admit(peer.identity, request.leader, key => sameProof(joinProof(key, "join", transcript), request.proof)).catch(() => null)
    if (!admitted) return refuse()
    await peer.send({ type: "ih_join_result", request: request.request, ok: true, proof: joinProof(admitted.key, "accept", transcript, admitted.roster), roster: admitted.roster })
    this.events?.emit("change")
    this.announceSoon(admitted.channel_id)
    this.topicsChanged()
  }

  private async onJoinResult(peer: NetworkPeer, result: z.infer<typeof joinResultFrame>) {
    for (const join of this.joins.values()) {
      const pending = join.requests.get(result.request)
      if (!pending || pending.peer !== peer) continue
      join.requests.delete(result.request)
      // A refusal may come from any peer on the rendezvous topic; keep waiting for the creator until the deadline.
      if (!result.ok || !sameProof(joinProof(join.key, "accept", pending.transcript, result.roster), result.proof)) return
      try {
        const done = await this.network.completeJoin(join.caller, peer.identity, result.roster)
        if (done.leader_changed) {
          const identity = await this.network.localIdentity()
          await this.network.append(done.channel_id, "membership", { action: "joined", hub_id: identity.id, leader_id: join.caller.id, leader_label: join.caller.label,
            peer_public_key: identity.signing, peer_identity: publicIdentity(identity) })
        }
        join.settle(null, { channel_id: done.channel_id, hub_id: done.hub_id })
        this.events?.emit("change")
        this.topicsChanged()
        await this.announce(peer)
        await this.pull(peer, done.channel_id)
      } catch (error) { join.settle(error) }
      return
    }
  }

  private async announce(peer: NetworkPeer, only?: string) {
    if (peer.closed()) return
    const local = await this.local(), state = this.state(peer)
    if (peer.identity.id === local) return
    for (const { channel_id } of await this.network.memberChannels()) {
      if (only && channel_id !== only) continue
      if (!await this.network.isMember(channel_id, peer.identity.id)) continue
      const last = await this.network.lastSeq(channel_id)
      if (state.announced.get(channel_id) === last) continue
      state.announced.set(channel_id, last)
      await peer.send({ type: "ih_have", channel_id, last }).catch(() => state.announced.delete(channel_id))
    }
  }
  private async announceAll(channelId: string) {
    for (const peer of this.shared.peers()) await this.announce(peer, channelId).catch(() => {})
  }
  /** Also re-announced later: an event appended inside a caller's transaction is only visible to readers after it commits. */
  private announceSoon(channelId: string) {
    for (const delay of [50, 1_000]) setTimeout(() => { void this.announceAll(channelId).catch(() => {}) }, delay).unref()
  }

  private async pull(peer: NetworkPeer, channelId: string) {
    const state = this.state(peer), last = state.remote.get(channelId)
    if (last === undefined || state.pulling.has(channelId) || peer.closed()) return
    if (!await this.network.isMember(channelId, await this.local()) || !await this.network.isMember(channelId, peer.identity.id)) return
    const key = `${peer.identity.id}:${channelId}`
    // A peer whose log restarted announces a lower head: read it again from the beginning.
    if (last < (this.cursors.get(key) ?? 0)) this.cursors.set(key, 0)
    const after = this.cursors.get(key) ?? 0
    if (last <= after) return
    state.pulling.add(channelId)
    await peer.send({ type: "ih_pull", channel_id: channelId, after }).catch(() => state.pulling.delete(channelId))
  }

  private async onPull(peer: NetworkPeer, request: z.infer<typeof pullFrame>) {
    const allowed = await this.network.isMember(request.channel_id, await this.local()) && await this.network.isMember(request.channel_id, peer.identity.id)
    if (!allowed) return peer.send({ type: "ih_page", channel_id: request.channel_id, cursor: request.after, last: request.after, events: [] })
    const rows = await this.store.db.query("SELECT seq,origin_hub_id,envelope FROM interhub_events WHERE channel_id=$1 AND seq>$2 ORDER BY seq LIMIT $3", [request.channel_id, request.after, PAGE_EVENTS])
    const events: { seq: number; envelope: unknown }[] = []
    let cursor = request.after, bytes = 0
    for (const row of rows) {
      const envelope = typeof row.envelope === "string" ? JSON.parse(row.envelope) : row.envelope
      const size = Buffer.byteLength(JSON.stringify(envelope))
      if (events.length && bytes + size > PAGE_BYTES) break
      cursor = Number(row.seq)
      // The requester already holds its own events.
      if (row.origin_hub_id === peer.identity.id) continue
      events.push({ seq: cursor, envelope }); bytes += size
    }
    await peer.send({ type: "ih_page", channel_id: request.channel_id, cursor, last: await this.network.lastSeq(request.channel_id), events })
  }

  private async onPage(peer: NetworkPeer, page: z.infer<typeof pageFrame>) {
    const state = this.state(peer)
    if (!state.pulling.has(page.channel_id)) return
    state.pulling.delete(page.channel_id)
    const key = `${peer.identity.id}:${page.channel_id}`, before = this.cursors.get(key) ?? 0
    if (page.cursor < before) return
    let cursor = before, stored = 0, interrupted = false
    for (const item of page.events) {
      if (item.seq <= cursor || item.seq > page.cursor) break
      try {
        const result = await this.network.receiveEnvelope(item.envelope, peer.identity)
        if (result.stored) { stored++; if (result.verified) await this.apply(result.seq!, result.verified) }
      } catch (error) {
        // A rejected event is skipped for good; anything else stops here so the same event is read again.
        this.lastError = reason(error)
        if (!(error instanceof MemoryError)) { interrupted = true; break }
      }
      cursor = item.seq
    }
    if (!interrupted) cursor = page.cursor
    this.cursors.set(key, cursor)
    state.remote.set(page.channel_id, Math.max(state.remote.get(page.channel_id) ?? 0, page.last))
    if (stored) {
      await this.retryPending()
      this.events?.emit("change")
      this.announceSoon(page.channel_id)
    }
    if (!interrupted) await this.pull(peer, page.channel_id)
  }

  private async apply(seq: number, verified: VerifiedEnvelope) {
    try {
      if (verified.kind === "chat") {
        const event = verified.envelope
        await this.chat.receive({ id: event.id, version: 1, channel_id: event.channel_id, origin_hub_id: event.origin_hub_id, origin_hub_name: verified.originName,
          origin_peer_id: event.origin_hub_id, occurred_at: event.occurred_at, payload: event.payload })
      } else await this.network.applyControl(verified)
      await this.store.db.query("UPDATE interhub_events SET applied_at=now(),apply_error=NULL WHERE seq=$1", [seq])
      return true
    } catch (error) {
      await this.store.db.query("UPDATE interhub_events SET apply_attempts=apply_attempts+1,apply_error=$2 WHERE seq=$1", [seq, reason(error).slice(0, 300)])
      return false
    }
  }

  /** Events stored before what they depend on (a message before its thread) are applied once it arrives. */
  private async retryPending() {
    for (let round = 0; round < 5; round++) {
      const rows = await this.store.db.query("SELECT seq,envelope FROM interhub_events WHERE applied_at IS NULL AND apply_attempts<$1 ORDER BY seq LIMIT 200", [MAX_APPLY_ATTEMPTS])
      let applied = 0
      for (const row of rows) {
        const envelope = typeof row.envelope === "string" ? JSON.parse(row.envelope) : row.envelope
        const verified = await this.network.verify(envelope).catch(async error => {
          await this.store.db.query("UPDATE interhub_events SET apply_attempts=$2,apply_error=$3 WHERE seq=$1", [row.seq, MAX_APPLY_ATTEMPTS, reason(error).slice(0, 300)])
          return null
        })
        if (verified && await this.apply(Number(row.seq), verified)) applied++
      }
      if (!applied) return
      this.events?.emit("change")
    }
  }

  private async touch(peer: NetworkPeer) {
    const id = peer.identity.id, now = Date.now()
    if (now - (this.touched.get(id) ?? 0) < 5_000) return
    this.touched.set(id, now)
    await this.network.touch(id)
  }

  private scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flushOutbox() }, 150)
    this.flushTimer.unref()
  }

  /** Publishes local threads, messages and agent presence of every inter-hub channel exactly once (presence on change). */
  async flushOutbox() {
    if (this.flushing) { this.flushAgain = true; return this.flushing }
    this.flushing = (async () => {
      do { this.flushAgain = false; await this.publishLocal() } while (this.flushAgain)
    })().catch(error => { this.lastError = reason(error) }).finally(() => { this.flushing = null })
    return this.flushing
  }

  private async publishLocal() {
    const db = this.store.db
    for (const { channel_id: channelId } of await this.network.memberChannels()) {
      let published = 0
      const threads = await db.query(`SELECT t.id,t.title,t.created_at,s.id AS author_id,COALESCE(s.nickname,s.label) AS author_label,s.cli_kind,c.leader_id
        FROM chat_threads t JOIN chat_sessions s ON s.id=t.created_by JOIN chat_channels c ON c.id=t.channel_id
        WHERE t.channel_id=$1 AND s.cli_kind NOT IN ('interhub-remote','hub') AND NOT EXISTS(SELECT 1 FROM interhub_outbox o WHERE o.key='thread:'||t.id)
        ORDER BY t.created_at,t.id LIMIT 200`, [channelId])
      for (const t of threads) {
        const author = { id: String(t.author_id), label: String(t.author_label), cli_kind: String(t.cli_kind), role: t.author_id === t.leader_id ? "leader" as const : "member" as const }
        if (await this.publishOnce(channelId, `thread:${t.id}`, "", { type: "thread", thread: { id: String(t.id), title: String(t.title), author, created_at: iso(t.created_at) } }, author.id)) published++
      }
      const messages = await db.query(`SELECT m.id,m.thread_id,m.text,m.reply_to,m.kind,m.created_at,s.id AS author_id,COALESCE(s.nickname,s.label) AS author_label,s.cli_kind,c.leader_id
        FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id JOIN chat_sessions s ON s.id=m.author_id JOIN chat_channels c ON c.id=t.channel_id
        WHERE t.channel_id=$1 AND s.cli_kind NOT IN ('interhub-remote','hub') AND NOT EXISTS(SELECT 1 FROM interhub_outbox o WHERE o.key='message:'||m.id)
        ORDER BY m.seq LIMIT 200`, [channelId])
      for (const m of messages) {
        // Local recipients mean nothing elsewhere; a remote agent is addressed by its id in its own hub.
        const mentions = (await db.query("SELECT recipient_id FROM chat_deliveries WHERE message_id=$1", [m.id]))
          .map(row => remoteSession.exec(String(row.recipient_id))?.[1]).filter((id): id is string => !!id && id.length <= 200).slice(0, 20)
        const author = { id: String(m.author_id), label: String(m.author_label), cli_kind: String(m.cli_kind), role: m.author_id === m.leader_id ? "leader" as const : "member" as const }
        if (await this.publishOnce(channelId, `message:${m.id}`, "", { type: "message", message: { id: String(m.id), thread_id: String(m.thread_id), author, text: String(m.text),
          mentions, reply_to: m.reply_to ?? null, kind: m.kind ?? null, created_at: iso(m.created_at) } }, author.id)) published++
      }
      published += await this.publishPresence(channelId)
      if (published) this.announceSoon(channelId)
    }
  }

  private async publishPresence(channelId: string) {
    const db = this.store.db, now = new Date().toISOString(), prefix = `presence:${channelId}:`
    const sessions = await db.query(`SELECT s.*,c.leader_id AS channel_leader FROM chat_sessions s JOIN chat_channels c ON c.id=$1
      WHERE (s.id=c.leader_id OR s.channel_id=$1) AND s.cli_kind NOT IN ('interhub-remote','hub') AND s.nickname IS NOT NULL`, [channelId])
    const known = await db.query("SELECT key FROM interhub_outbox WHERE channel_id=$1 AND key LIKE 'presence:%'", [channelId])
    const current = new Set<string>()
    let published = 0
    for (const s of sessions) {
      current.add(String(s.id))
      const state = s.removed_at || s.closed_at ? "offline" as const : sessionStatus(s).connection_state as "online" | "offline" | "unknown"
      const session = { id: String(s.id), label: String(s.nickname ?? s.label), cli_kind: String(s.cli_kind), role: s.id === s.channel_leader ? "leader" as const : "member" as const }
      if (await this.publishOnce(channelId, prefix + s.id, digest({ session, state }), { type: "presence", presence: { session, state, occurred_at: now } }, session.id)) published++
    }
    for (const row of known) {
      const id = String(row.key).slice(prefix.length)
      if (current.has(id)) continue
      const s = (await db.query("SELECT nickname,label,cli_kind FROM chat_sessions WHERE id=$1", [id]))[0]
      const session = { id, label: String(s?.nickname ?? s?.label ?? "Agente"), cli_kind: String(s?.cli_kind ?? "unknown"), role: "member" as const }
      if (await this.publishOnce(channelId, prefix + id, digest({ gone: id }), { type: "presence", presence: { session, state: "offline", occurred_at: now } }, id)) published++
    }
    return published
  }

  private publishOnce(channelId: string, key: string, fingerprint: string, payload: InterhubChatPayload, agentId: string) {
    return this.store.db.transaction(async sql => {
      const prior = (await sql.query("SELECT digest FROM interhub_outbox WHERE key=$1", [key]))[0]
      if (prior && prior.digest === fingerprint) return false
      // An event over the wire limit is recorded as handled without an envelope instead of blocking every later one.
      const envelope = await this.network.append(channelId, chatKind(payload), payload, agentId).catch(error => {
        if (error instanceof MemoryError) { this.lastError = error.message; return null }
        throw error
      })
      await sql.query(`INSERT INTO interhub_outbox(key,channel_id,envelope_id,digest) VALUES($1,$2,$3,$4)
        ON CONFLICT(key) DO UPDATE SET envelope_id=excluded.envelope_id,digest=excluded.digest,updated_at=now()`, [key, channelId, envelope?.id ?? "", fingerprint])
      return Boolean(envelope)
    })
  }
}
