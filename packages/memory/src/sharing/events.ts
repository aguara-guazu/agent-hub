import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { parse, check } from '../contracts.js'
import { type AgentContext, agentLabel } from '../agents.js'
import { canonical, digest, encrypt, decrypt, signature, validSignature, seal, unseal } from './crypto.js'
import { active, eventSchema, payloadSchema, type Policy, type Payload, type SharedEvent, type Publication } from './schema.js'
import { SharedProjects } from './projects.js'

export class SharedEvents extends SharedProjects {
  async append(projectId: string, payload: Payload) {
    const { project, who, member } = await this.member(projectId, payload.kind !== 'receipt')
    check(member.role !== 'reader' || payload.kind === 'receipt', 'Reader no puede publicar', 403)
    const created_at = new Date().toISOString(), nonce = randomUUID()
    const header = { project: projectId, policy: project.policy_hash, author: who.id, created_at, nonce }
    const keys = await this.keys(projectId)
    check(Buffer.byteLength(canonical(payload)) <= 36_000_000, 'El aporte supera 36 MB; dividí la fuente antes de publicarla')
    const body = encrypt(parse(payloadSchema, payload), keys[project.policy.epoch]!, `event:${digest(header)}`)
    const unsigned = { ...header, body }, event = { ...unsigned, id: digest(unsigned), signature: signature(unsigned, who) }
    await this.receive(event, who.id)
    return event
  }
  async receive(raw: unknown, via: string, archive?: { policy_hash: string; policies: string[]; exported_at: string }) {
    const event = parse(eventSchema, raw)
    check(event.body.ciphertext.length <= 48_000_000, 'El aporte supera el límite de transferencia')
    if ((await this.store.db.query('SELECT id FROM shared_events WHERE id=$1', [event.id])).length) return { duplicate: true }
    const { id: _id, signature: _signature, ...unsigned } = event
    check(digest(unsigned) === event.id, 'Evento alterado')
    const project = await this.get(event.project)
    const row = (await this.store.db.query<{ document: Policy }>('SELECT document FROM shared_policies WHERE hash=$1 AND project_id=$2', [event.policy, event.project]))[0]
    check(row, 'Falta la política que autoriza este aporte', 409)
    const author = row.document.members.find(m => m.identity.id === event.author), current = project.policy.members.find(m => m.identity.id === event.author)
    check(active(author, Date.parse(event.created_at)), 'El autor no tenía acceso al publicar', 403)
    check(Date.parse(event.created_at) >= Date.parse(row.document.created_at) && Date.parse(event.created_at) <= Date.now() + 300_000, 'Fecha de aporte inválida')
    check(validSignature(unsigned, event.signature, author!.identity), 'Firma de aporte inválida', 403)
    // Revocation accepts only historical events already checkpointed by an administrator. Backdating cannot bypass it.
    const archived = archive && archive.policies.includes(event.policy) && Date.parse(event.created_at) <= Date.parse(archive.exported_at)
      && (project.policy_hash === archive.policy_hash || project.policy.issuer === project.genesis.recovery.id && project.policy.parent === archive.policy_hash)
    check(active(current) || project.policy.history.includes(event.id) || archived, 'Aporte no confirmado de un miembro vencido o revocado', 403)
    const { body: _body, ...header } = unsigned, keys = await this.keys(event.project)
    const payload = parse(payloadSchema, decrypt(event.body, keys[row.document.epoch]!, `event:${digest(header)}`))
    check(author!.role !== 'reader' || payload.kind === 'receipt', 'El autor no puede aportar', 403)
    check(payload.kind === 'receipt' || current?.role !== 'reader' || project.policy.history.includes(event.id) || archived, 'El autor ya no tiene permiso de escritura', 403)
    if (payload.kind === 'publication') {
      check(payload.source_kind === 'event' || payload.fragments.length > 0, 'La publicación no tiene contenido')
      check(payload.facts.every(f => f.evidence.length > 0 && f.evidence.every(i => i < payload.fragments.length)), 'Evidencia fuera de la fuente')
      if (payload.url) check(['https:', 'http:'].includes(new URL(payload.url).protocol), 'URL de fuente inválida')
      if (payload.occurred_at) parse(z.iso.datetime({ offset: true }), payload.occurred_at)
      if (payload.attachment) {
        const bytes = Buffer.from(payload.attachment.data_base64, 'base64')
        check(bytes.length === payload.attachment.size && createHash('sha256').update(bytes).digest('hex') === payload.attachment.sha256, 'Adjunto alterado')
      }
    }
    if (payload.kind === 'object' && payload.value.kind === 'task' && payload.value.external_url) check(['https:', 'http:'].includes(new URL(payload.value.external_url).protocol), 'URL de tarea inválida')
    if (payload.kind === 'object' && payload.value.kind === 'collection') {
      const { fields, rows } = payload.value
      check(fields.every(f => f.type !== 'entity'), 'Referencias locales no transferibles')
      check(new Set(rows.map(r => r.key)).size === rows.length, 'Filas repetidas')
      for (const { values } of rows) {
        check(Object.keys(values).every(key => fields.some(f => f.key === key)), 'Campo desconocido')
        for (const field of fields) {
          const value = values[field.key]
          if (value === undefined || value === null || value === '') { check(!field.required, 'Falta un campo requerido'); continue }
          if (['text', 'number', 'boolean'].includes(field.type)) check(typeof value === (field.type === 'text' ? 'string' : field.type), 'Tipo de campo inválido')
          if (field.type === 'date') parse(z.iso.date(), value)
          if (field.type === 'datetime') parse(z.iso.datetime({ offset: true }), value)
        }
      }
    }
    if (payload.kind === 'message') {
      const duration = Date.parse(payload.expires_at) - Date.parse(event.created_at)
      check(duration > 0 && duration <= 30 * 86_400_000, 'Vencimiento de mensaje inválido')
      check(!payload.to_agent || !!payload.to_member, 'Un agente privado necesita destinatario')
      check(!!payload.to_member === !!payload.private_body && !!payload.to_member === !!payload.sender_body, 'Cifrado privado inválido')
      check(!payload.to_member || row.document.members.some(m => m.identity.id === payload.to_member), 'Destinatario ajeno al proyecto')
    }
    if (payload.kind === 'claim') check(Date.parse(payload.expires_at) <= Date.parse(event.created_at) + 600_000, 'Reserva demasiado larga')
    await this.store.db.query('INSERT INTO shared_events(id,project_id,document,payload,received_from) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
      [event.id, event.project, JSON.stringify(event), JSON.stringify(payload), via])
    return { duplicate: false }
  }
  async events(projectId: string, after = 0, limit = 50) {
    return this.store.db.query<{ seq: number; document: SharedEvent; payload: Payload }>('SELECT seq,document,payload FROM shared_events WHERE project_id=$1 AND seq>$2 ORDER BY seq LIMIT $3', [projectId, after, limit])
  }
  async message(projectId: string, text: string, expiresAt: string, toMember?: string, toAgent?: string, replyTo?: string, agent?: AgentContext) {
    const { project, who } = await this.member(projectId, true)
    check(!toAgent || !!toMember, 'Elegí al participante del agente destinatario')
    let private_body = null, sender_body = null
    if (toMember) {
      const target = project.policy.members.find(m => m.identity.id === toMember)
      check(active(target), 'El destinatario no tiene acceso vigente', 403)
      const content = { text, to_agent: toAgent ?? null }, purpose = `message:${projectId}`
      private_body = await seal(content, target!.identity, purpose); sender_body = await seal(content, who, purpose)
    }
    const event = await this.append(projectId, { kind: 'message', text: toMember ? '[Mensaje privado]' : text, agent: agent?.agent_id ?? null,
      agent_label: agent ? agentLabel(agent) : who.name, to_member: toMember ?? null, to_agent: toAgent ?? null, expires_at: expiresAt,
      reply_to: replyTo ?? null, private_body, sender_body })
    return { id: event.id, expires_at: expiresAt }
  }
  async messages(projectId: string, agent?: AgentContext, offset = 0, limit = 50, unreadOnly = false) {
    await this.member(projectId)
    const who = await this.identity(), agentId = agent?.agent_id ?? null
    const rows = await this.store.db.query<{ id: string; document: SharedEvent; payload: any }>(`SELECT id,document,payload FROM shared_events
      WHERE project_id=$1 AND payload->>'kind'='message' AND payload->>'expires_at'>now()
      AND (payload->>'to_member' IS NULL OR payload->>'to_member'=$2 OR document->>'author'=$2)
      AND ($3 IS NULL OR payload->>'to_agent' IS NULL OR payload->>'to_agent'=$3 OR (document->>'author'=$2 AND payload->>'agent'=$3))
      ORDER BY seq DESC`, [projectId, who.id, agentId])
    const receipts = await this.store.db.query<{ payload: any }>(`SELECT payload FROM shared_events WHERE project_id=$1 AND payload->>'kind'='receipt'
      AND document->>'author'=$2 AND payload->>'agent' IS $3`, [projectId, who.id, agentId])
    const states = new Map<string, string>()
    for (const receipt of receipts) { const p = receipt.payload; if (states.get(p.message) !== 'handled') states.set(p.message, p.state) }
    const visible = rows.filter(r => !unreadOnly || !states.has(r.id) && !(r.document.author === who.id && r.payload.agent === agentId))
    const items = []
    for (const row of visible.slice(offset, offset + limit)) {
      const p = row.payload
      let text = p.text
      if (p.to_member) {
        try { text = (await unseal(row.document.author === who.id ? p.sender_body : p.private_body, who, `message:${projectId}`)).text }
        catch { continue }
      }
      items.push({ id: row.id, text, author: row.document.author, agent: p.agent, agent_label: p.agent_label, to_member: p.to_member,
        to_agent: p.to_agent, reply_to: p.reply_to, expires_at: p.expires_at, created_at: row.document.created_at, state: states.get(row.id) ?? 'unread' })
    }
    return { items, total: visible.length, offset, limit }
  }
  async receipt(projectId: string, messageId: string, state: 'read' | 'handled', agent?: AgentContext) {
    const row = (await this.store.db.query<{ document: SharedEvent; payload: any }>("SELECT document,payload FROM shared_events WHERE id=$1 AND project_id=$2 AND payload->>'kind'='message'", [messageId, projectId]))[0]
    const who = await this.identity()
    check(row && Date.parse(row.payload.expires_at) > Date.now() && (!row.payload.to_member || row.payload.to_member === who.id || row.document.author === who.id)
      && (!agent || !row.payload.to_agent || row.payload.to_agent === agent.agent_id || row.document.author === who.id && row.payload.agent === agent.agent_id), 'Mensaje no disponible', 404)
    const existing = await this.store.db.query(`SELECT id FROM shared_events WHERE project_id=$1 AND payload->>'kind'='receipt'
      AND payload->>'message'=$2 AND document->>'author'=$3 AND payload->>'agent' IS $4 AND (payload->>'state'=$5 OR payload->>'state'='handled')`,
    [projectId, messageId, who.id, agent?.agent_id ?? null, state])
    if (!existing.length) await this.append(projectId, { kind: 'receipt', message: messageId, state, agent: agent?.agent_id ?? null })
    return { id: messageId, state }
  }
  async notice(projectId: string, agent: AgentContext) {
    const messages = await this.messages(projectId, agent, 0, 100, true)
    if (!messages.total) return null
    const recipient = agent.agent_id, fingerprint = digest(messages.items.map(m => m.id).sort())
    const old = (await this.store.db.query('SELECT * FROM shared_notices WHERE project_id=$1 AND recipient=$2', [projectId, recipient]))[0]
    if (old?.fingerprint === fingerprint && Date.now() - Date.parse(old.shown_at) < 30 * 60_000) return null
    await this.store.db.query(`INSERT INTO shared_notices(project_id,recipient,fingerprint,shown_at) VALUES($1,$2,$3,now())
      ON CONFLICT(project_id,recipient) DO UPDATE SET fingerprint=excluded.fingerprint,shown_at=excluded.shown_at`, [projectId, recipient, fingerprint])
    return { project_id: projectId, pending: messages.total, skill: 'hub-collaboration', tool: 'memory_read_messages',
      guidance: 'Pending project messages. Read the hub-collaboration skill if unread; use memory_read_messages when appropriate. Reading is not accepting.' }
  }
  async claim(projectId: string, key: string, agent?: AgentContext) {
    await this.member(projectId, true)
    const rows = await this.store.db.query<{ document: SharedEvent }>(`SELECT document FROM shared_events WHERE project_id=$1 AND payload->>'kind'='claim'
      AND payload->>'key'=$2 AND payload->>'expires_at'>now() ORDER BY document->>'created_at',id`, [projectId, key])
    const who = await this.identity()
    if (rows.length) return { claimed: rows[0]!.document.author === who.id, owner: rows[0]!.document.author, coordinated: true }
    const expires_at = new Date(Date.now() + 300_000).toISOString()
    await this.append(projectId, { kind: 'claim', key, expires_at, agent: agent?.agent_id ?? null })
    return { claimed: true, owner: who.id, expires_at, coordinated: false }
  }
  async publicationHeads(projectId: string, key: string) {
    const rows = await this.store.db.query<{ id: string; payload: Publication }>("SELECT id,payload FROM shared_events WHERE project_id=$1 AND payload->>'kind'='publication' AND payload->>'key'=$2 ORDER BY id", [projectId, key])
    const superseded = new Set(rows.flatMap(r => r.payload.previous))
    return rows.filter(r => !superseded.has(r.id))
  }
}
