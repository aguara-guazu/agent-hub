import { createRequire } from 'node:module'
import { type Duplex } from 'node:stream'
import { z } from 'zod'
import { check, parse, MemoryError } from '../contracts.js'
import { publicIdentity, signature, validSignature, digest, type Identity } from './crypto.js'
import { active } from './schema.js'
import type { SharedPublications } from './publications.js'

// Hyperswarm exposes Noise-encrypted streams and a DHT, with no application server or account service.
const require = createRequire(import.meta.url)
type PeerSocket = Duplex & { remotePublicKey: Buffer }
interface Discovery { refresh(): Promise<void> }
interface Swarm {
  keyPair: { publicKey: Buffer }; connections: Set<PeerSocket>
  join(topic: Buffer): Discovery; leave(topic: Buffer): Promise<void>; destroy(): Promise<void>
  on(event: 'connection', handler: (socket: PeerSocket) => void): this
  on(event: 'error', handler: (error: Error) => void): this
}
export const networkSettingsSchema = z.object({ enabled: z.boolean(), bootstrap: z.array(z.string().min(1).max(300)).max(20), bind_host: z.ipv4().default('0.0.0.0') }).strict()
const MAX_FRAME = 55_000_000
const helloSchema = z.object({ type: z.literal('hello'), identity: z.object({ id: z.string(), signing: z.string(), encryption: z.string(), name: z.string() }),
  noise_key: z.string(), created_at: z.string(), projects: z.array(z.string().uuid()).max(1000), signature: z.string() }).strict()

export class SharedNetwork {
  private swarm: Swarm | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private joined = new Set<string>()
  private discoveries = new Map<string, { handle: Discovery; next: number; refreshing: boolean }>()
  private connections = new Set<{ socket: PeerSocket; offer: () => Promise<void>; idle: () => Promise<void>; projects: () => string[] }>()
  private running: Promise<void> | null = null
  private stopped = false
  private lastError: string | null = null
  constructor(readonly sharing: SharedPublications) {}
  async settings() {
    const row = (await this.sharing.store.db.query("SELECT value FROM settings WHERE key='sharing-network'"))[0]
    return row?.value ?? { enabled: false, bootstrap: [] }
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
    if (!settings.enabled) return
    if (!this.swarm) {
      const Hyperswarm = require('hyperswarm'), DHT = require('hyperdht'), who = await this.sharing.identity()
      // Each network lifetime gets a fresh transport key. Reusing a crashed
      // process's Noise key can route reconnects into its stale DHT session.
      // The signed hello binds this ephemeral key to the persistent Hub identity.
      this.swarm = new Hyperswarm({ maxPeers: 32,
        dht: new DHT({ host: settings.bind_host ?? '0.0.0.0', ...(settings.bootstrap.length ? { bootstrap: settings.bootstrap } : {}) }) }) as Swarm
      this.swarm.on('error', () => { this.lastError = 'La red P2P no está disponible; se reintentará' })
      this.swarm.on('connection', socket => {
        // Attach synchronously: a reset during initialization must not crash the Hub.
        socket.on('error', () => {})
        void this.connect(socket, who).catch(() => socket.destroy())
      })
    }
    const projects = await this.sharing.store.db.query<{ id: string }>('SELECT id FROM shared_projects WHERE enabled=1')
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
    await this.sharing.applyPending()
  }
  private async connect(socket: PeerSocket, who: Identity) {
    const swarm = this.swarm!
    if (this.stopped || socket.destroyed || !swarm) { socket.destroy(); return }
    let remote: z.infer<typeof helloSchema> | null = null, buffer = Buffer.alloc(0), queue = Promise.resolve(), pending = 0, queuedBytes = 0
    const cursors = new Map<string, number>(), offered = new Map<string, string>(), requested = new Set<string>()
    const timeout = setTimeout(() => socket.destroy(), 15_000); timeout.unref()
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
    const entry = { socket, offer, idle: () => queue, projects: () => remote?.projects ?? [] }; this.connections.add(entry)
    socket.once('close', () => { clearTimeout(timeout); void queue.finally(() => this.connections.delete(entry)) })
    const receive = async (frame: any) => {
      if (!remote) {
        const hello = parse(helloSchema, frame), { signature: proof, ...unsigned } = hello
        check(hello.noise_key === socket.remotePublicKey.toString('hex') && Math.abs(Date.now() - Date.parse(hello.created_at)) < 300_000
          && validSignature(unsigned, proof, hello.identity), 'Identidad del peer inválida', 403)
        remote = hello; clearTimeout(timeout); this.lastError = null
        await this.sharing.store.db.query(`INSERT INTO shared_peers(id,name,last_seen_at) VALUES($1,$2,now()) ON CONFLICT(id) DO UPDATE SET name=excluded.name,last_seen_at=now(),error=NULL`, [hello.identity.id, hello.identity.name])
        await offer(); return
      }
      if (frame.type === 'offer') {
        const id = String(frame.packet?.genesis?.id)
        // A recovery holder or newly invited member may not exist in our old
        // membership yet. The signed chain must establish their authority first.
        check(this.joined.has(id) && remote.projects.includes(id), 'Proyecto no anunciado', 403)
        await this.sharing.importInvitation(frame.packet)
        if (!await dataAccess(id)) return
        await offer()
        if (!requested.has(id) && Number(frame.last) > (cursors.get(id) ?? 0)) {
          requested.add(id); await send({ type: 'pull', project: id, after: cursors.get(id) ?? 0 })
        }
      } else if (frame.type === 'pull') {
        const project = String(frame.project), state = await dataAccess(project)
        if (!state) return
        check(Number.isSafeInteger(frame.after) && frame.after >= 0, 'Cursor inválido')
        // One event may include a 25 MB attachment; frame bounds also cap memory usage.
        const rows = await this.sharing.events(project, frame.after, 1)
        // A peer may hold offline contributions that an owner later revoked without
        // checkpointing. Skip them without trapping every reconnect at that cursor.
        const transferable = rows.filter(r => {
          const author = state.policy.members.find(m => m.identity.id === r.document.author)
          return state.policy.history.includes(r.document.id) || active(author) && (author!.role !== 'reader' || r.payload.kind === 'receipt')
        })
        await send({ type: 'page', project, cursor: rows.at(-1)?.seq ?? frame.after, rows: transferable.map(r => ({ seq: r.seq, document: r.document })) })
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
        queue = queue.then(async () => { if (!socket.destroyed) await receive(JSON.parse(line.toString('utf8'))) })
          .catch(error => { this.lastError = error instanceof MemoryError ? `Conexión cerrada: ${error.message}` : 'Un peer envió datos inválidos o perdió acceso; conexión cerrada'; socket.destroy() })
          .finally(() => { pending--; queuedBytes -= line.length })
      }
    })
    const body = { type: 'hello' as const, identity: publicIdentity(who), noise_key: swarm.keyPair.publicKey.toString('hex'), created_at: new Date().toISOString(), projects: [...this.joined] }
    await send({ ...body, signature: signature(body, who) })
  }
  async status() { return { settings: await this.settings(), connected_peers: this.connections.size, projects: this.joined.size, error: this.lastError } }
  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const connections = [...this.connections]
    for (const c of connections) c.socket.destroy()
    await this.running
    await Promise.allSettled(connections.map(c => c.idle()))
    await this.swarm?.destroy(); this.swarm = null; this.joined.clear(); this.discoveries.clear(); this.connections.clear()
  }
}
