import { createRequire } from 'node:module'
import { type Duplex } from 'node:stream'
import { z } from 'zod'
import { check, parse, MemoryError } from '../contracts.js'
import { publicIdentity, signature, validSignature, digest, type Identity, type PublicIdentity } from './crypto.js'
import { active } from './schema.js'
import type { SharedPublications } from './publications.js'

// Hyperswarm exposes Noise-encrypted streams and a DHT, with no application server or account service.
const require = createRequire(import.meta.url)
type PeerSocket = Duplex & { remotePublicKey: Buffer }
interface PeerInfo { topics: Buffer[] }
interface Discovery { refresh(): Promise<void> }
interface Swarm {
  keyPair: { publicKey: Buffer }; connections: Set<PeerSocket>; peers: Map<string, PeerInfo>
  join(topic: Buffer, options?: { server: boolean; client: boolean }): Discovery; leave(topic: Buffer): Promise<void>; destroy(): Promise<void>
  on(event: 'connection', handler: (socket: PeerSocket, info: PeerInfo) => void): this
  on(event: 'error', handler: (error: Error) => void): this
}

/** Authenticated peer handed to a NetworkExtension: identity and keys come from the verified hello, never from later frames. */
export interface NetworkPeer {
  readonly identity: PublicIdentity
  readonly localNoise: string
  readonly remoteNoise: string
  /** Hex topics through which this hub discovered the peer as a client (empty when the peer dialed in). */
  topics(): string[]
  send(frame: unknown): Promise<void>
  closed(): boolean
}
export interface NetworkTopic { topic: string; server: boolean; client: boolean; refreshMs: number }
/**
 * Additional protocol multiplexed on the sharing connections. Frames whose type starts with `ih_` are routed to it.
 * It is only ever spoken to peers the extension itself selects, so peers that predate it never receive its frames.
 */
export interface NetworkExtension {
  topics(): Promise<NetworkTopic[]>
  connected(peer: NetworkPeer): Promise<void>
  frame(peer: NetworkPeer, frame: Record<string, unknown>, bytes: number): Promise<void>
  disconnected(peer: NetworkPeer): void
  tick(peers: NetworkPeer[]): Promise<void>
}
export const networkSettingsSchema = z.object({ enabled: z.boolean().optional().transform(() => true), bootstrap: z.array(z.string().min(1).max(300)).max(20), bind_host: z.ipv4().default('0.0.0.0') }).strict()
const MAX_FRAME = 55_000_000
/**
 * Both sides send hello as their first frame as soon as the connection opens. Hyperswarm can report a client
 * connection as open that the remote never accepted, so no hello ever arrives; closing it at this deadline lets
 * Hyperswarm redial instead of holding the dead connection (each one delays an inter-hub join by this long).
 */
const HELLO_TIMEOUT_MS = 5_000
const helloSchema = z.object({ type: z.literal('hello'), identity: z.object({ id: z.string(), signing: z.string(), encryption: z.string(), name: z.string() }),
  noise_key: z.string(), created_at: z.string(), projects: z.array(z.string().uuid()).max(1000), signature: z.string() }).strict()

interface Transfer { acknowledged: number; served: number; pulling: boolean }
interface Connection {
  socket: PeerSocket; offer: () => Promise<void>; idle: () => Promise<void>; projects: () => string[]
  identity: () => string | undefined; transfers: Map<string, Transfer>; peer: () => NetworkPeer | null
}

export class SharedNetwork {
  private swarm: Swarm | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private joined = new Set<string>()
  private discoveries = new Map<string, { handle: Discovery; next: number; refreshing: boolean }>()
  private extensionTopics = new Map<string, { handle: Discovery; mode: string; next: number; refreshing: boolean }>()
  private connections = new Set<Connection>()
  private running: Promise<void> | null = null
  private stopped = false
  private lastError: string | null = null
  private extension: NetworkExtension | null = null
  constructor(readonly sharing: SharedPublications) {}
  attach(extension: NetworkExtension) { this.extension = extension }
  /** Authenticated peers currently connected. */
  peers(): NetworkPeer[] { return [...this.connections].map(c => c.peer()).filter((p): p is NetworkPeer => !!p && !p.closed()) }
  /** Runs a full update after the one in flight, so topic changes made before the call are applied. */
  async refresh() { await this.running; return this.tick() }
  async settings() {
    const row = (await this.sharing.store.db.query("SELECT value FROM settings WHERE key='sharing-network'"))[0]
    // Older installs may have saved enabled=false. Networking is now always on.
    return parse(networkSettingsSchema, row?.value ?? { bootstrap: [] })
  }
  async configure(raw: unknown) {
    const settings = parse(networkSettingsSchema, raw)
    await this.stop()
    await this.sharing.store.db.query("INSERT INTO settings(key,value) VALUES('sharing-network',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(settings)])
    this.stopped = false
    await this.start()
    return this.status()
  }
  async start() {
    if (this.stopped || this.timer) return
    await this.tick()
    if (this.stopped) return
    this.timer = setInterval(() => { void this.tick() }, 10_000); this.timer.unref()
  }
  async tick() {
    if (this.running || this.stopped) return this.running
    this.running = this.update().catch(error => { this.lastError = error instanceof Error ? error.message : 'No se pudo sincronizar' }).finally(() => { this.running = null })
    return this.running
  }
  private async update() {
    await this.sharing.syncSources()
    const settings = await this.settings()
    const projects = await this.sharing.store.db.query<{ id: string }>('SELECT id FROM shared_projects WHERE enabled=1')
    // A failed read keeps the current extension topics instead of leaving all of them.
    const extensionTopics = this.extension ? await this.extension.topics().catch(() => null) : []
    if (!this.swarm && !projects.length && !extensionTopics?.length) return
    if (!this.swarm) {
      const Hyperswarm = require('hyperswarm'), DHT = require('hyperdht'), who = await this.sharing.identity()
      // Each network lifetime gets a fresh transport key. Reusing a crashed
      // process's Noise key can route reconnects into its stale DHT session.
      // The signed hello binds this ephemeral key to the persistent Hub identity.
      this.swarm = new Hyperswarm({ maxPeers: 32,
        dht: new DHT({ host: settings.bind_host ?? '0.0.0.0', ...(settings.bootstrap.length ? { bootstrap: settings.bootstrap } : {}) }) }) as Swarm
      this.swarm.on('error', () => { this.lastError = 'La red P2P no está disponible; se reintentará' })
      this.swarm.on('connection', (socket, info) => {
        // Attach synchronously: a reset during initialization must not crash the Hub.
        socket.on('error', () => {})
        void this.connect(socket, who, info).catch(() => socket.destroy())
      })
    }
    if (extensionTopics) await this.joinExtensionTopics(extensionTopics)
    else this.lastError = 'No se pudieron leer los canales entre hubs; se reintentará'
    const wanted = new Set(projects.map(p => p.id))
    const changed = wanted.size !== this.joined.size || [...wanted].some(id => !this.joined.has(id))
    for (const id of wanted) if (!this.joined.has(id)) {
      const handle = this.swarm.join(Buffer.from(digest({ project: id, protocol: 'agenthub-sharing-v1' }), 'hex'))
      this.discoveries.set(id, { handle, next: Date.now() + 10_000, refreshing: false }); this.joined.add(id)
    }
    for (const id of this.joined) if (!wanted.has(id)) { await this.swarm.leave(Buffer.from(digest({ project: id, protocol: 'agenthub-sharing-v1' }), 'hex')); this.joined.delete(id); this.discoveries.delete(id) }
    if (changed) for (const connection of this.connections) connection.socket.destroy()
    for (const connection of this.connections) await connection.offer().catch(() => connection.socket.destroy())
    // Simultaneous first announcements can both return an empty lookup. Hyperswarm's
    // default discovery refresh is ~10 minutes; retry empty projects promptly instead.
    for (const [id, discovery] of this.discoveries) {
      if (discovery.refreshing || Date.now() < discovery.next || [...this.connections].some(c => !c.socket.destroyed && c.projects().includes(id))) continue
      discovery.refreshing = true; discovery.next = Date.now() + 30_000
      void discovery.handle.refresh().catch(() => { this.lastError = 'No se pudo renovar el descubrimiento P2P; se reintentará' }).finally(() => { discovery.refreshing = false })
    }
    await this.extension?.tick(this.peers()).catch(() => { this.lastError = 'No se pudo sincronizar un canal entre hubs; se reintentará' })
    await this.sharing.applyPending()
  }
  private async joinExtensionTopics(wanted: NetworkTopic[]) {
    const swarm = this.swarm
    if (!swarm) return
    const next = new Map(wanted.map(t => [t.topic, t]))
    for (const [topic, state] of this.extensionTopics) {
      const desired = next.get(topic)
      if (desired && `${desired.server}:${desired.client}` === state.mode) continue
      await swarm.leave(Buffer.from(topic, 'hex')).catch(() => {})
      this.extensionTopics.delete(topic)
    }
    for (const topic of wanted) {
      const state = this.extensionTopics.get(topic.topic)
      if (!state) {
        const handle = swarm.join(Buffer.from(topic.topic, 'hex'), { server: topic.server, client: topic.client })
        this.extensionTopics.set(topic.topic, { handle, mode: `${topic.server}:${topic.client}`, next: Date.now() + (topic.refreshMs || 30_000), refreshing: false })
        continue
      }
      if (!topic.refreshMs || state.refreshing || Date.now() < state.next) continue
      state.refreshing = true; state.next = Date.now() + topic.refreshMs
      void state.handle.refresh().catch(() => { this.lastError = 'No se pudo renovar el descubrimiento P2P; se reintentará' }).finally(() => { state.refreshing = false })
    }
  }
  private async connect(socket: PeerSocket, who: Identity, info?: PeerInfo) {
    const swarm = this.swarm!
    if (this.stopped || socket.destroyed || !swarm) { socket.destroy(); return }
    let remote: z.infer<typeof helloSchema> | null = null, buffer = Buffer.alloc(0), queue = Promise.resolve(), pending = 0, queuedBytes = 0
    const cursors = new Map<string, number>(), offered = new Map<string, string>(), requested = new Set<string>()
    const transfers = new Map<string, Transfer>()
    const timeout = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS); timeout.unref()
    let outgoing = Promise.resolve()
    const send = (value: unknown) => {
      const data = Buffer.from(JSON.stringify(value) + '\n')
      check(data.length <= MAX_FRAME, 'El aporte supera el tamaño de transferencia permitido')
      const sent = outgoing.then(async () => {
        // Noise caps each atomic write at 16 MiB. Serialize whole frames so
        // concurrent offers cannot interleave with a chunked attachment.
        for (let offset = 0; offset < data.length; offset += 1_048_576) {
          check(!socket.destroyed, 'El peer se desconectó')
          if (socket.write(data.subarray(offset, offset + 1_048_576))) continue
          // Keep the reader running while the writer waits on backpressure.
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => { socket.off('close', closed); socket.off('drain', drained); socket.off('error', failed) }
            const closed = () => { cleanup(); reject(new Error('El peer se desconectó')) }
            const failed = (error: Error) => { cleanup(); reject(error) }
            const drained = () => { cleanup(); resolve() }
            socket.once('close', closed); socket.once('drain', drained); socket.once('error', failed)
          })
        }
      })
      outgoing = sent.catch(() => {})
      return sent
    }
    const allowed = async (projectId: string, current = true) => {
      check(remote?.projects.includes(projectId), 'Proyecto no anunciado', 403)
      const project = await this.sharing.get(projectId)
      check((!current || !project.conflict) && project.enabled, 'Proyecto pausado', 403)
      const peer = project.policy.members.find(m => m.identity.id === remote!.identity.id)
      check(peer && (!current || active(peer)), 'Peer sin acceso vigente', 403)
      return project
    }
    const offer = async () => {
      if (!remote) return
      for (const id of this.joined) {
        if (!remote.projects.includes(id)) continue
        const project = await allowed(id, false).catch(() => null)
        if (!project) continue
        const me = project.policy.members.find(m => m.identity.id === who.id)
        if (active(me) && me!.role === 'owner') await this.sharing.renew(id, remote.identity.id).catch(() => {})
        const packet = await this.sharing.invitation(id)
        const [row] = await this.sharing.store.db.query('SELECT COALESCE(max(seq),0) AS seq FROM shared_events WHERE project_id=$1', [id])
        const revision = digest({ last: packet.policies.at(-1), seq: row!.seq })
        if (offered.get(id) === revision) continue
        offered.set(id, revision)
        if (!transfers.has(id)) transfers.set(id, { acknowledged: 0, served: 0, pulling: false })
        await send({ type: 'offer', packet, last: row!.seq })
      }
    }
    const dataAccess = async (projectId: string) => {
      const project = await allowed(projectId, false)
      const peer = project.policy.members.find(m => m.identity.id === remote!.identity.id)
      const me = project.policy.members.find(m => m.identity.id === who.id)
      if (project.conflict || !active(peer) || !active(me)) {
        requested.delete(projectId)
        // Keep the policy channel alive: destroying a socket here can discard the
        // revocation queued behind an in-flight pull and leave the peer unaware.
        await offer()
        return null
      }
      return project
    }
    let peer: NetworkPeer | null = null
    const entry = { socket, offer, idle: () => queue, projects: () => remote?.projects ?? [], identity: () => remote?.identity.id, transfers, peer: () => peer }; this.connections.add(entry)
    socket.once('close', () => {
      clearTimeout(timeout)
      void queue.finally(() => { this.connections.delete(entry); if (peer) this.extension?.disconnected(peer) })
    })
    const receive = async (frame: any, bytes: number) => {
      if (!remote) {
        const hello = parse(helloSchema, frame), { signature: proof, ...unsigned } = hello
        check(hello.noise_key === socket.remotePublicKey.toString('hex') && Math.abs(Date.now() - Date.parse(hello.created_at)) < 300_000
          && validSignature(unsigned, proof, hello.identity), 'Identidad del peer inválida', 403)
        remote = hello; clearTimeout(timeout); this.lastError = null
        await this.sharing.store.db.query(`INSERT INTO shared_peers(id,name,last_seen_at) VALUES($1,$2,now()) ON CONFLICT(id) DO UPDATE SET name=excluded.name,last_seen_at=now(),error=NULL`, [hello.identity.id, hello.identity.name])
        const identity = publicIdentity(hello.identity)
        const remoteNoise = socket.remotePublicKey.toString('hex')
        // Hyperswarm may replace the PeerInfo of a key (duplicate swaps, GC); a later lookup tags the current one.
        peer = { identity, localNoise: swarm.keyPair.publicKey.toString('hex'), remoteNoise,
          topics: () => [...new Set([...(info?.topics ?? []), ...(swarm.peers?.get(remoteNoise)?.topics ?? [])].map(t => t.toString('hex')))], send, closed: () => socket.destroyed }
        await offer()
        if (this.extension) void this.extension.connected(peer).catch(() => {})
        return
      }
      if (typeof frame.type === 'string' && frame.type.startsWith('ih_')) {
        check(this.extension && peer, 'Mensaje P2P desconocido')
        await this.extension.frame(peer, frame, bytes)
      } else if (frame.type === 'offer') {
        const id = String(frame.packet?.genesis?.id)
        // A recovery holder or newly invited member may not exist in our old
        // membership yet. The signed chain must establish their authority first.
        check(this.joined.has(id) && remote.projects.includes(id), 'Proyecto no anunciado', 403)
        await this.sharing.importInvitation(frame.packet)
        if (!await dataAccess(id)) return
        await offer()
        if (!requested.has(id) && (!cursors.has(id) || Number(frame.last) > cursors.get(id)!)) {
          requested.add(id); await send({ type: 'pull', project: id, after: cursors.get(id) ?? 0 })
        }
      } else if (frame.type === 'pull') {
        const project = String(frame.project), state = await dataAccess(project)
        if (!state) return
        check(Number.isSafeInteger(frame.after) && frame.after >= 0, 'Cursor inválido')
        const transfer = transfers.get(project) ?? { acknowledged: 0, served: 0, pulling: false }
        // The next pull acknowledges the previous page was accepted into the peer's
        // event log. This works with 0.8.0 peers, without introducing new wire frames.
        // Never interpret merely writing a page to a socket as remote receipt.
        check(frame.after <= transfer.served, 'Cursor no enviado')
        transfer.acknowledged = frame.after; transfer.pulling = true
        transfers.set(project, transfer)
        // One event may include a 25 MB attachment; frame bounds also cap memory usage.
        const rows = await this.sharing.events(project, frame.after, 1)
        // A peer may hold offline contributions that an owner later revoked without
        // checkpointing. Skip them without trapping every reconnect at that cursor.
        const transferable = rows.filter(r => {
          const author = state.policy.members.find(m => m.identity.id === r.document.author)
          return state.policy.history.includes(r.document.id) || active(author) && (author!.role !== 'reader' || r.payload.kind === 'receipt')
        })
        transfer.served = rows.at(-1)?.seq ?? frame.after
        await send({ type: 'page', project, cursor: transfer.served, rows: transferable.map(r => ({ seq: r.seq, document: r.document })) })
      } else if (frame.type === 'page') {
        const project = String(frame.project)
        if (!await dataAccess(project)) return
        check(requested.has(project) && Array.isArray(frame.rows) && frame.rows.length <= 1, 'Página no solicitada')
        const before = cursors.get(project) ?? 0
        check(Number.isSafeInteger(frame.cursor) && frame.cursor >= before, 'Cursor inválido')
        for (const row of frame.rows) {
          check(Number.isSafeInteger(row.seq) && row.seq > before && row.seq <= frame.cursor && row.document?.project === project, 'Página inválida')
          await this.sharing.receive(row.document, remote.identity.id)
        }
        cursors.set(project, frame.cursor)
        if (frame.cursor > before) await send({ type: 'pull', project, after: frame.cursor })
        else { requested.delete(project); await this.sharing.applyPending() }
      } else throw new Error('Mensaje P2P desconocido')
    }
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_FRAME) { socket.destroy(); return }
      let end: number
      while ((end = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1)
        queuedBytes += line.length
        if (++pending > 32 || queuedBytes > MAX_FRAME * 2) { socket.destroy(); return }
        // Keep draining Noise while a reply is under backpressure. Pausing both peers
        // while they send large pages simultaneously would deadlock the connection.
        queue = queue.then(async () => { if (!socket.destroyed) await receive(JSON.parse(line.toString('utf8')), line.length) })
          .catch(error => { this.lastError = error instanceof MemoryError ? `Conexión cerrada: ${error.message}` : 'Un peer envió datos inválidos o perdió acceso; conexión cerrada'; socket.destroy() })
          .finally(() => { pending--; queuedBytes -= line.length })
      }
    })
    const body = { type: 'hello' as const, identity: publicIdentity(who), noise_key: swarm.keyPair.publicKey.toString('hex'), created_at: new Date().toISOString(), projects: [...this.joined] }
    await send({ ...body, signature: signature(body, who) })
  }
  async status() {
    const connections = [...this.connections].filter(c => !c.socket.destroyed && c.identity())
    const peers = [], localId = (await this.sharing.identity()).id
    for (const connection of connections) for (const projectId of connection.projects()) {
      if (!this.joined.has(projectId)) continue
      const project = await this.sharing.get(projectId).catch(() => null)
      const member = project?.policy.members.find(m => m.identity.id === connection.identity())
      const me = project?.policy.members.find(m => m.identity.id === localId)
      if (!project || !active(member) || !active(me) || project.conflict || !project.enabled) continue
      const transfer = connection.transfers.get(projectId)
      // seq is global across projects: count rows, never divide sequence numbers.
      const [counts] = await this.sharing.store.db.query(`SELECT count(*) AS total,
        COALESCE(sum(CASE WHEN seq <= $2 THEN 1 ELSE 0 END),0) AS confirmed
        FROM shared_events WHERE project_id=$1`, [projectId, transfer?.acknowledged ?? 0])
      const total = Number(counts!.total), confirmed = Number(counts!.confirmed)
      peers.push({ project_id: projectId, member_id: connection.identity()!, total, confirmed,
        state: !transfer?.pulling ? 'waiting' : confirmed < total ? 'syncing' : 'synced' })
    }
    return { settings: await this.settings(), connected_peers: connections.length, projects: this.joined.size, peers, error: this.lastError }
  }
  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const connections = [...this.connections]
    for (const c of connections) c.socket.destroy()
    await this.running
    await Promise.allSettled(connections.map(c => c.idle()))
    await this.swarm?.destroy(); this.swarm = null; this.joined.clear(); this.discoveries.clear(); this.extensionTopics.clear(); this.connections.clear()
  }
}
