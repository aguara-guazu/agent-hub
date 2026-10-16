import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createSocket } from 'node:dgram'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { SharedPublications } from '../src/sharing/publications.js'
import { SharedNetwork } from '../src/sharing/network.js'
import { exportProject, restoreProject } from '../src/sharing/archive.js'
import { publicIdentity, signature, unseal } from '../src/sharing/crypto.js'
import { withoutSignature } from '../src/sharing/schema.js'
import { MemoryOperations } from '../src/operations.js'
import { MemoryAI } from '../src/ai.js'
import { Vault, defaultAI } from '../src/config.js'
import type { AgentContext } from '../src/agents.js'
import { prepareSharedProcessing, finishSharedProcessing } from '../src/sharing/processing.js'

const resources: { directory: string; db: MemoryDatabase; network: SharedNetwork }[] = []
const agent = (id: string): AgentContext => ({ agent_id: id, cli_kind: 'codex_cli', client: 'test', session_id: `session-${id}-test`, cwd: '/test' })
async function hub(name: string) {
  const directory = await mkdtemp(join(tmpdir(), 'hub-sharing-test-')), db = new MemoryDatabase(join(directory, 'memory.sqlite'))
  await db.migrate()
  const store = new MemoryStore(db, directory), sharing = new SharedPublications(store), network = new SharedNetwork(sharing)
  resources.push({ directory, db, network }); await sharing.rename(name)
  const vault = new Vault(directory), ops = new MemoryOperations(store, new MemoryAI(async () => defaultAI, vault), undefined, vault)
  return { store, sharing, db, network, ops }
}
async function fixture() {
  const a = await hub('Ana'), b = await hub('Bruno'), c = await hub('Carla')
  const project = await a.store.create({ kind: 'project', title: 'Compartido' }), created = await a.sharing.create(project.id)
  const invitation = await a.sharing.changeMember(project.id, publicIdentity(await b.sharing.identity()), 'maintainer', false)
  await b.sharing.importInvitation(invitation)
  return { a, b, c, id: project.id, phrase: created.recovery_phrase, invitation }
}
async function copy(a: Awaited<ReturnType<typeof hub>>, b: Awaited<ReturnType<typeof hub>>, id: string) {
  await b.sharing.importInvitation(await a.sharing.invitation(id))
  for (const row of await a.sharing.events(id, 0, 1000)) await b.sharing.receive(row.document, (await a.sharing.identity()).id)
  await b.sharing.applyPending()
}
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const r of resources.splice(0)) { await r.network.stop(); await r.db.close(); await rm(r.directory, { recursive: true, force: true }) }
})

describe('proyectos compartidos cifrados', () => {
  it('comparte fuentes existentes y futuras automáticamente sin publicar las de otros proyectos', async () => {
    const a = await hub('Ana'), b = await hub('Bruno')
    const project = await a.store.create({ kind: 'project', title: 'Automático' }), other = await a.store.create({ kind: 'project', title: 'Otro' })
    const initial = await a.store.ingest({ kind: 'note', title: 'Existente', external_id: 'existing', text: 'Antes de compartir', project_ids: [project.id] })
    await a.store.ingest({ kind: 'note', title: 'Otro proyecto', external_id: 'private', text: 'Sólo en el otro proyecto', project_ids: [other.id] })
    await a.sharing.create(project.id)
    await b.sharing.join(await a.sharing.changeMember(project.id, publicIdentity(await b.sharing.identity()), 'maintainer', false))
    await a.network.tick(); await copy(a, b, project.id)
    expect((await b.store.list({ kind: 'note', project_id: project.id })).items.map(e => e.title)).toEqual(['Existente'])
    const later = await a.store.ingest({ kind: 'note', title: 'Nueva', external_id: 'later', text: 'Después de compartir', project_ids: [project.id] })
    await a.network.tick(); await copy(a, b, project.id)
    expect((await b.store.list({ kind: 'note', project_id: project.id })).total).toBe(2)
    const count = (await a.sharing.events(project.id)).length
    await a.network.tick(); await b.network.tick()
    expect((await a.sharing.events(project.id)).length).toBe(count)
    expect((await b.sharing.events(project.id)).length).toBe(count)
    const before = (await a.sharing.publications(project.id)).find(p => p.entity_id === initial.entity_id)!.key
    await a.store.update(initial.entity_id, { data: { text: 'Actualización automática' } })
    await a.network.tick(); await copy(a, b, project.id)
    expect((await a.sharing.publications(project.id)).some(p => p.key === before)).toBe(true)
    expect((await b.store.list({ kind: 'note', project_id: project.id })).total).toBe(2)
    expect((await a.sharing.sourceSyncStatus(project.id))).toEqual([])
    expect(later.entity_id).toBeTruthy()
  })
  it('los cambios recibidos no rebotan y el escaneo automático no resuelve conflictos', async () => {
    const { a, b, id } = await fixture()
    const local = await a.store.ingest({ kind: 'note', title: 'Decisión', external_id: 'auto', text: 'Original', project_ids: [id] })
    await a.network.tick(); await copy(a, b, id)
    const remote = (await b.store.list({ kind: 'note', project_id: id })).items[0]!
    await b.store.update(remote.id, { data: { text: 'Cambio de Bruno' } }); await b.network.tick(); await copy(b, a, id)
    const count = (await a.sharing.events(id)).length
    await a.network.tick(); await b.network.tick()
    expect((await a.sharing.events(id)).length).toBe(count)
    expect((await b.sharing.events(id)).length).toBe(count)
    await a.store.update(local.entity_id, { data: { text: 'Cambio offline de Ana' } })
    await b.store.update(remote.id, { data: { text: 'Otro cambio de Bruno' } })
    await a.network.tick(); await b.network.tick(); await copy(a, b, id); await copy(b, a, id)
    await a.network.tick(); await b.network.tick()
    for (const peer of [a, b]) expect((await peer.sharing.publications(id))[0]!.conflict).toBe(true)
  })
  it('el escaneo avanza por lotes y una fuente inválida no bloquea las demás', async () => {
    const { a, id } = await fixture()
    for (let n = 0; n < 5; n++) await a.store.ingest({ kind: 'note', title: `Fuente ${n}`, external_id: `batch-${n}`, text: `Dato ${n}`, project_ids: [id] })
    await a.store.ingest({ kind: 'note', title: 'x'.repeat(400), external_id: 'invalid', text: 'Título demasiado largo para el protocolo', project_ids: [id] })
    for (let n = 0; n < 3; n++) await a.sharing.syncSources(id, 2)
    expect((await a.sharing.publications(id))).toHaveLength(5)
    const pending = await a.sharing.sourceSyncStatus(id)
    expect(pending).toHaveLength(1); expect(pending[0]!.error).toBeTruthy()
  })
  it('el usuario observa el foro sin recibos; sólo agentes pueden escribir o marcar mensajes', async () => {
    const { a, id } = await fixture(), input = { project_id: id, text: 'Coordinación de agentes', expires_at: new Date(Date.now() + 60_000).toISOString() }
    await expect(a.ops.call('send_message', input)).rejects.toThrow('Sólo los agentes')
    const sent = await a.ops.call('send_message', input, 'mcp', agent('author'))
    expect((await a.ops.call('read_messages', { project_id: id })).total).toBe(1)
    await expect(a.ops.call('ack_message', { project_id: id, message_id: sent.id, state: 'handled' })).rejects.toThrow('Sólo los agentes')
    expect((await a.sharing.events(id)).filter(e => e.payload.kind === 'receipt')).toHaveLength(0)
    expect((await a.ops.call('read_messages', { project_id: id, unread_only: true }, 'mcp', agent('reader'))).total).toBe(1)
    expect((await a.sharing.events(id)).filter(e => e.payload.kind === 'receipt')).toHaveLength(1)
  })
  it('conserva la frase cifrada sólo para owners, también al promover y quitar permisos', async () => {
    const { a, b, c, id, phrase } = await fixture()
    const ana = await a.sharing.identity(), bruno = await b.sharing.identity(), carla = await c.sharing.identity()
    expect((await a.sharing.recoveryPhrase(id)).recovery_phrase).toBe(phrase)
    expect((await new SharedPublications(a.store).recoveryPhrase(id)).recovery_phrase).toBe(phrase)
    await expect(b.sharing.recoveryPhrase(id)).rejects.toThrow('Sólo los owners')
    await c.sharing.join(await a.sharing.changeMember(id, publicIdentity(carla), 'reader', false))
    await expect(c.sharing.recoveryPhrase(id)).rejects.toThrow('Sólo los owners')
    const packet = await a.sharing.invitation(id), envelope = packet.policies.at(-1)!.recovery_keys![ana.id]!
    expect(JSON.stringify(packet)).not.toContain(phrase)
    expect(Object.keys(packet.policies.at(-1)!.recovery_keys!)).toEqual([ana.id])
    await expect(unseal(envelope, bruno, `project-recovery:${id}`)).rejects.toThrow()
    await expect(unseal(envelope, carla, `project-recovery:${id}`)).rejects.toThrow()
    await c.sharing.join(await a.sharing.changeMember(id, publicIdentity(carla), 'owner', true))
    expect((await c.sharing.recoveryPhrase(id)).recovery_phrase).toBe(phrase)
    await c.sharing.join(await a.sharing.changeMember(id, publicIdentity(carla), 'maintainer', false))
    await expect(c.sharing.recoveryPhrase(id)).rejects.toThrow('Sólo los owners')
    expect((await c.sharing.get(id)).policy.recovery_keys?.[carla.id]).toBeUndefined()
    await c.sharing.join(await a.sharing.changeMember(id, publicIdentity(carla), 'owner', true))
    await c.sharing.join(await a.sharing.changeMember(id, publicIdentity(carla), 'owner', true, true))
    await expect(c.sharing.recoveryPhrase(id)).rejects.toThrow('Sólo los owners')
  })
  it('la delegación preserva sobres de owners y no permite alterarlos ni agregar destinatarios', async () => {
    const { a, b, c, id, phrase } = await fixture(), who = await b.sharing.identity()
    await b.sharing.join(await a.sharing.changeMember(id, publicIdentity(who), 'maintainer', true))
    const parent = (await b.sharing.get(id)).policy
    const packet = await b.sharing.changeMember(id, publicIdentity(await c.sharing.identity()), 'reader', false)
    const next = packet.policies.at(-1)!, ownerId = (await a.sharing.identity()).id
    expect(next.recovery_keys).toEqual(parent.recovery_keys)
    for (const alter of [
      (p: typeof next) => { delete (p as Partial<typeof next>).recovery_keys },
      (p: typeof next) => { p.recovery_keys![who.id] = p.recovery_keys![ownerId]! },
      (p: typeof next) => { p.recovery_keys![ownerId]!.ciphertext = 'AAAA' },
    ]) {
      const changed = structuredClone(next); alter(changed); changed.signature = signature(withoutSignature(changed), who)
      expect(() => b.sharing.validatePolicy(packet.genesis, changed, parent)).toThrow(/recuperación/)
    }
    await a.sharing.join(packet)
    expect((await a.sharing.recoveryPhrase(id)).recovery_phrase).toBe(phrase)
  })
  it('rechaza políticas sin recuperación cifrada desde la creación y la importación', async () => {
    const { a, c, id } = await fixture(), packet = await a.sharing.invitation(id)
    const initial = packet.policies[0]!, who = await a.sharing.identity()
    await expect(a.sharing.makePolicy(packet.genesis, null, initial.members, who, {})).rejects.toThrow('requiere recuperación')
    const missing = structuredClone(packet)
    delete (missing.policies[0] as Partial<typeof initial>).recovery_keys
    missing.policies[0]!.signature = signature(withoutSignature(missing.policies[0]!), who)
    await expect(c.sharing.join(missing)).rejects.toThrow()
    expect(await c.store.db.query('SELECT id FROM shared_projects')).toHaveLength(0)
    const empty = structuredClone(initial); empty.recovery_keys = {}
    empty.signature = signature(withoutSignature(empty), who)
    expect(() => a.sharing.validatePolicy(packet.genesis, empty, null)).toThrow('exclusivamente para los owners')
  })
  it('liga invitaciones a identidad, impide escalar roles y hace vencer miembros a los 14 días', async () => {
    const { a, b, c, id, invitation } = await fixture()
    await expect(c.sharing.importInvitation(invitation)).rejects.toThrow('otra identidad')
    await expect(b.sharing.changeMember(id, publicIdentity(await c.sharing.identity()), 'owner', true)).rejects.toThrow('permisos')
    const policy = structuredClone(invitation); policy.policies.at(-1)!.members.at(-1)!.role = 'owner'
    await expect(b.sharing.importInvitation(policy)).rejects.toThrow()
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 15 * 86_400_000)
    await expect(b.sharing.member(id)).rejects.toThrow('venció')
    expect((await a.sharing.member(id)).member.role).toBe('owner')
  })
  it('permite entrar con masterkey, limita delegación y renueva sólo antes del vencimiento', async () => {
    const { a, b, c, id, phrase } = await fixture(), d = await hub('Diego')
    await b.sharing.importInvitation(await a.sharing.changeMember(id, publicIdentity(await b.sharing.identity()), 'maintainer', true))
    const invitation = await b.sharing.changeMember(id, publicIdentity(await c.sharing.identity()), 'reader', false)
    await a.sharing.importInvitation(invitation)
    await expect(b.sharing.changeMember(id, publicIdentity(await c.sharing.identity()), 'maintainer', false)).rejects.toThrow('agregar')
    await expect(d.sharing.join(invitation, phrase.split(' ').reverse().join(' '))).rejects.toThrow()
    await d.sharing.join(invitation, phrase)
    expect((await d.sharing.member(id)).member.role).toBe('owner')
    const realNow = Date.now(), target = (await b.sharing.identity()).id
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(realNow + 8 * 86_400_000)
    expect(await a.sharing.renew(id, target)).toBe(true)
    const renewed = (await a.sharing.get(id)).policy.members.find(m => m.identity.id === target)!
    expect(Date.parse(renewed.expires_at!) - Date.now()).toBe(14 * 86_400_000)
    vi.setSystemTime(realNow + 23 * 86_400_000)
    await expect(a.sharing.renew(id, target)).rejects.toThrow('venció')
  })
  it('replica una fuente una sola vez, preserva la fuente local y rechaza datos alterados', async () => {
    const { a, b, id } = await fixture()
    const source = await a.store.ingest({ kind: 'meeting', title: 'Planificación', external_id: 'meeting-1', project_ids: [id], fragments: [{ text: 'Entregamos el viernes.' }] })
    const version = source.version_id
    await a.sharing.publish(id, source.entity_id)
    expect((await a.store.detail(source.entity_id)).sources[0].current_version_id).toBe(version)
    await copy(a, b, id); await copy(a, b, id)
    expect((await b.store.list({ project_id: id, kind: 'meeting' })).total).toBe(1)
    expect((await a.sharing.publish(id, source.entity_id)).duplicate).toBe(true)
    const bad = structuredClone((await a.sharing.events(id))[0]!.document); bad.body.ciphertext = 'AAAA'; bad.id = 'a'.repeat(64)
    await expect(b.sharing.receive(bad, 'attacker')).rejects.toThrow('alterado')
  })
  it('filtra fragmentos de otros proyectos y mantiene el original privado intacto', async () => {
    const { a, b, id } = await fixture(), other = await a.store.create({ kind: 'project', title: 'Privado' })
    const source = await a.store.ingest({ kind: 'meeting', title: 'Dos clientes', external_id: 'mixed', project_ids: [id, other.id],
      fragments: [{ text: 'Público del proyecto', project_ids: [id] }, { text: 'Secreto del otro cliente', project_ids: [other.id] }] })
    await a.sharing.publish(id, source.entity_id); await copy(a, b, id)
    const imported = (await b.store.list({ project_id: id, kind: 'meeting' })).items[0]!
    expect((await b.store.fragments(imported.id)).items.map(f => f.text)).toEqual(['Público del proyecto'])
    expect((await a.store.fragments(source.entity_id)).items).toHaveLength(2)
  })
  it('entrega privados sólo al destinatario, avisa sin marcar leído y respeta vencimientos', async () => {
    const { a, b, c, id } = await fixture()
    await c.sharing.importInvitation(await a.sharing.changeMember(id, publicIdentity(await c.sharing.identity()), 'maintainer', false))
    await b.sharing.importInvitation(await a.sharing.invitation(id))
    const sent = await a.sharing.message(id, 'Sólo para Bruno', new Date(Date.now() + 60_000).toISOString(), (await b.sharing.identity()).id, 'b', undefined, agent('a'))
    expect((await a.ops.call('read_messages', { project_id: id }, 'mcp', agent('a'))).items[0].text).toBe('Sólo para Bruno')
    await copy(a, b, id); await copy(a, c, id)
    expect((await c.sharing.messages(id, agent('c'))).items).toHaveLength(0)
    expect((await b.sharing.messages(id, agent('otro'))).items).toHaveLength(0)
    const notice = await b.ops.collaborationNotice('list_tasks', { project_id: id }, {}, agent('b'))
    expect(notice).toMatchObject({ pending: 1, tool: 'memory_read_messages' })
    expect(await b.ops.collaborationNotice('list_tasks', { project_id: id }, {}, agent('b'))).toBeNull()
    expect((await b.sharing.messages(id, agent('b'), 0, 50, true)).total).toBe(1)
    expect((await b.ops.call('read_messages', { project_id: id }, 'mcp', agent('b'))).items[0].text).toBe('Sólo para Bruno')
    expect((await b.sharing.messages(id, agent('b'), 0, 50, true)).total).toBe(0)
    await b.sharing.receipt(id, sent.id, 'handled', agent('b'))
    expect((await b.sharing.messages(id, agent('b'))).items[0]!.state).toBe('handled')
    await a.sharing.message(id, 'Vencido pronto', new Date(Date.now() + 1000).toISOString())
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect((await a.sharing.messages(id)).items.some(m => m.text === 'Vencido pronto')).toBe(false)
  })
  it('reader sólo lee; la revocación invalida aportes offline no confirmados', async () => {
    const { a, b, c, id, phrase } = await fixture()
    await c.sharing.importInvitation(await a.sharing.changeMember(id, publicIdentity(await c.sharing.identity()), 'reader', false))
    await expect(c.sharing.message(id, 'No puedo', new Date(Date.now() + 60_000).toISOString())).rejects.toThrow('reader')
    await b.sharing.importInvitation(await a.sharing.invitation(id))
    const source = await b.store.ingest({ kind: 'note', title: 'Aporte histórico aceptado', external_id: 'historical', text: 'Este dato precede a la revocación', project_ids: [id] })
    const historical = await b.sharing.publish(id, source.entity_id); await copy(b, a, id)
    const late = await b.sharing.append(id, { kind: 'claim', key: 'offline', expires_at: new Date(Date.now() + 60_000).toISOString(), agent: null })
    await a.sharing.changeMember(id, publicIdentity(await b.sharing.identity()), 'maintainer', false, true)
    await expect(a.sharing.receive(late, (await b.sharing.identity()).id)).rejects.toThrow('revocado')
    await b.sharing.importInvitation(await a.sharing.invitation(id))
    await expect(b.sharing.member(id)).rejects.toThrow('revocado')
    await c.sharing.join(await a.sharing.invitation(id), phrase)
    expect((await c.sharing.get(id)).policy.history).toContain(historical.event_id)
    await copy(c, a, id); await copy(a, c, id)
    expect((await c.store.list({ kind: 'note', project_id: id })).items[0]!.title).toBe('Aporte histórico aceptado')
  })
  it('restaura cifrado con identidad o frase y recupera un único nodo como owner', async () => {
    const { a, c, id, phrase } = await fixture()
    const source = await a.store.ingest({ kind: 'document', title: 'Documento', external_id: 'doc-1', project_ids: [id], text: 'Contenido recuperable' })
    await a.sharing.publish(id, source.entity_id)
    const backup = await exportProject(a.sharing, id)
    expect(JSON.stringify(backup)).not.toContain('Contenido recuperable')
    await expect(restoreProject(c.sharing, backup)).rejects.toThrow('frase')
    await expect(restoreProject(c.sharing, backup, phrase.split(' ').reverse().join(' '))).rejects.toThrow()
    expect(await restoreProject(c.sharing, backup, phrase)).toMatchObject({ recovered_as_owner: true })
    expect((await c.sharing.member(id)).member.role).toBe('owner')
    expect((await c.sharing.recoveryPhrase(id)).recovery_phrase).toBe(phrase)
    expect((await c.store.list({ project_id: id, kind: 'document' })).total).toBe(1)
    const d = await hub('Ana restaurada')
    const originalIdentity = await a.sharing.identity()
    d.sharing.vault.save('sharing-identity', { seed: originalIdentity.seed, name: originalIdentity.name })
    expect(await restoreProject(d.sharing, backup)).toMatchObject({ recovered_as_owner: false })
    expect((await d.sharing.member(id)).member.role).toBe('owner')
    expect((await d.sharing.recoveryPhrase(id)).recovery_phrase).toBe(phrase)
    const broken = structuredClone(backup); broken.body.ciphertext = 'AAAA'
    await expect(restoreProject(d.sharing, broken)).rejects.toThrow('Firma')
  })
  it('detecta ediciones concurrentes y conserva ambas hasta resolver', async () => {
    const { a, b, id } = await fixture()
    const first = await a.store.ingest({ kind: 'note', title: 'Decisión', external_id: 'decision', project_ids: [id], text: 'Inicial' })
    await a.sharing.publish(id, first.entity_id); await copy(a, b, id)
    const p = (await a.sharing.events(id))[0]!.payload
    if (p.kind !== 'publication') throw new Error('fixture')
    await a.sharing.append(id, { ...p, previous: [(await a.sharing.events(id))[0]!.document.id], fragments: [{ text: 'Versión A' }] })
    await b.sharing.append(id, { ...p, previous: [(await b.sharing.events(id))[0]!.document.id], fragments: [{ text: 'Versión B' }] })
    await copy(a, b, id); await copy(b, a, id)
    expect((await a.sharing.publications(id))[0]!.conflict).toBe(true)
    const heads = await a.sharing.publicationHeads(id, p.key)
    await a.sharing.resolve(id, p.key, heads[0]!.id); await copy(a, b, id)
    expect((await b.sharing.publications(id))[0]!.conflict).toBe(false)
  })
  it('sincroniza sobre sockets Noise reales usando un bootstrap local', async () => {
    const probe = createSocket('udp4')
    await new Promise<void>(resolve => probe.bind(0, '127.0.0.1', resolve))
    const port = probe.address().port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const DHT = createRequire(import.meta.url)('hyperdht'), bootstrap = DHT.bootstrapper(port, '127.0.0.1', { host: '127.0.0.1' })
    await bootstrap.ready()
    try {
      const { a, b, c, id, phrase } = await fixture(), address = `127.0.0.1:${bootstrap.address().port}`
      await c.sharing.importInvitation(await a.sharing.changeMember(id, publicIdentity(await c.sharing.identity()), 'maintainer', false))
      await b.sharing.importInvitation(await a.sharing.invitation(id))
      // Bruno saw Carla's offline contribution, but Ana revoked her before seeing it.
      await c.sharing.message(id, 'No debe propagarse después de revocar', new Date(Date.now() + 120_000).toISOString())
      await copy(c, b, id)
      await a.sharing.changeMember(id, publicIdentity(await c.sharing.identity()), 'maintainer', false, true)
      await b.sharing.importInvitation(await a.sharing.invitation(id))
      await a.sharing.message(id, 'Mensaje transportado por P2P', new Date(Date.now() + 120_000).toISOString())
      for (const [index, peer] of [a, b].entries()) {
        const source = await peer.store.ingest({ kind: 'document', title: `Documento grande ${index}`, external_id: `large-${index}`, project_ids: [id],
          // Each encrypted event exceeds Noise's 16 MiB atomic-write limit.
          fragments: Array.from({ length: 300 }, (_, i) => ({ text: `Documento ${index}, parte ${i}. ` + 'contenido '.repeat(5000) })) })
        await peer.sharing.publish(id, source.entity_id)
      }
      await a.network.configure({ enabled: true, bind_host: '127.0.0.1', bootstrap: [address] }); await b.network.configure({ enabled: true, bind_host: '127.0.0.1', bootstrap: [address] })
      await vi.waitFor(async () => { expect((await b.sharing.messages(id)).items.some(m => m.text === 'Mensaje transportado por P2P'), JSON.stringify({ a: await a.network.status(), b: await b.network.status() })).toBe(true) }, { timeout: 30_000, interval: 300 })
      await vi.waitFor(async () => {
        expect((await a.store.list({ kind: 'document', project_id: id })).total).toBe(2)
        expect((await b.store.list({ kind: 'document', project_id: id })).total).toBe(2)
      }, { timeout: 30_000, interval: 300 })
      expect((await a.sharing.messages(id)).items.some(m => m.text === 'No debe propagarse después de revocar')).toBe(false)
      const recovered = await hub('Nuevo owner con masterkey'), recoveredId = (await recovered.sharing.identity()).id
      await recovered.sharing.join(await a.sharing.invitation(id), phrase)
      await recovered.network.configure({ enabled: true, bind_host: '127.0.0.1', bootstrap: [address] })
      await vi.waitFor(async () => {
        expect((await a.sharing.get(id)).policy.members.find(m => m.identity.id === recoveredId)?.role).toBe('owner')
        expect((await recovered.store.list({ kind: 'document', project_id: id })).total).toBe(2)
      }, { timeout: 30_000, interval: 300 })
    } finally { for (const r of resources) await r.network.stop(); await bootstrap.destroy() }
  }, 40_000)
  it('cuatro hubs que importan la misma fuente convergen sin multiplicar reuniones ni hechos', async () => {
    const { a, b, c, id } = await fixture(), d = await hub('Diego')
    await a.sharing.changeMember(id, publicIdentity(await c.sharing.identity()), 'maintainer', false)
    const invitation = await a.sharing.changeMember(id, publicIdentity(await d.sharing.identity()), 'maintainer', false)
    for (const peer of [b, c, d]) await peer.sharing.importInvitation(invitation)
    for (const [i, peer] of [a, b, c, d].entries()) {
      const source = await peer.store.ingest({ kind: 'meeting', title: 'Reunión común', account: `account-${i}`, external_id: `local-${i}`,
        url: 'https://example.com/meeting/shared', project_ids: [id], fragments: [{ text: 'El viernes entregamos y Ana valida.' }] })
      const fragment = (await peer.store.fragments(source.entity_id)).items[0]!
      const fact = await peer.store.create({ kind: 'fact', title: 'Entrega', data: { text: i === 3 ? 'Ana valida.' : 'Entregamos el viernes.', category: 'commitment' }, project_ids: [id] })
      await peer.db.query('INSERT INTO evidence(entity_id,fragment_id) VALUES($1,$2)', [fact.id, fragment.id])
      await peer.sharing.publish(id, source.entity_id)
    }
    for (const peer of [b, c, d]) await copy(peer, a, id)
    for (const peer of [b, c, d]) await copy(a, peer, id)
    for (const peer of [a, b, c, d]) {
      expect((await peer.store.list({ project_id: id, kind: 'meeting' })).total).toBe(1)
      expect((await peer.store.list({ project_id: id, kind: 'fact' })).total).toBe(2)
      expect((await peer.sharing.publications(id))[0]!.conflict).toBe(false)
    }
  })
  it('reserva procesamiento y reutiliza el resultado publicado con una clave independiente del hub', async () => {
    const { a, b, id } = await fixture(), config = { ...defaultAI, extraction: 'ollama' as const, extraction_model: 'test-model' }
    const source = await a.store.ingest({ kind: 'meeting', title: 'Trabajo', external_id: 'work', text: 'Para procesar una vez', project_ids: [id] })
    await a.sharing.publish(id, source.entity_id); await copy(a, b, id)
    const remote = (await b.store.list({ project_id: id, kind: 'meeting' })).items[0]!
    const remoteVersion = (await b.store.detail(remote.id)).sources[0].current_version_id
    const work = await prepareSharedProcessing(a.store, source.version_id, config)
    expect(work.work).toHaveLength(1); await copy(a, b, id)
    expect((await prepareSharedProcessing(b.store, remoteVersion, config)).defer).toBe(true)
    await finishSharedProcessing(a.store, work.work, true); await copy(a, b, id)
    expect((await prepareSharedProcessing(b.store, remoteVersion, config)).reusable).toBe(true)
  })
  it('comparte tareas y colecciones y las incluye en el respaldo', async () => {
    const { a, b, c, id, phrase } = await fixture()
    const task = await a.ops.call('save_task', { project_id: id, title: 'Entregar', status: 'in_progress', origin: 'manual' })
    const collection = await a.store.create({ kind: 'collection', title: 'Equipo', project_ids: [id], data: { fields: [{ key: 'name', label: 'Nombre', type: 'text', required: true }] } })
    await a.store.addRecord(collection.id, { values: { name: 'Ana' }, idempotency_key: 'ana' })
    await a.sharing.publish(id, task.id); await a.sharing.publish(id, collection.id)
    await copy(a, b, id); await copy(a, b, id)
    expect((await b.ops.call('list_tasks', { project_id: id })).items).toHaveLength(1)
    const sharedCollection = (await b.store.list({ project_id: id, kind: 'collection' })).items[0]!
    expect((await b.store.records(sharedCollection.id, 50, 0)).items[0]!.values).toEqual({ name: 'Ana' })
    expect((await b.sharing.publish(id, sharedCollection.id)).duplicate).toBe(true)
    await restoreProject(c.sharing, await exportProject(a.sharing, id), phrase)
    expect((await c.ops.call('list_tasks', { project_id: id })).items[0].status).toBe('in_progress')
    expect((await c.store.list({ project_id: id, kind: 'collection' })).total).toBe(1)
  })
  it('detecta ramas de administración y la masterkey permite elegir y propagar una recuperación', async () => {
    const { a, b, c, id, phrase } = await fixture(), d = await hub('Diego')
    await b.sharing.importInvitation(await a.sharing.changeMember(id, publicIdentity(await b.sharing.identity()), 'owner', true))
    await a.sharing.changeMember(id, publicIdentity(await c.sharing.identity()), 'maintainer', false)
    await b.sharing.changeMember(id, publicIdentity(await d.sharing.identity()), 'maintainer', false)
    const source = await b.store.ingest({ kind: 'note', title: 'Trabajo de otra rama', external_id: 'branch-work', text: 'Conservar al recuperar', project_ids: [id] })
    await b.sharing.publish(id, source.entity_id)
    await expect(a.sharing.importInvitation(await b.sharing.invitation(id))).rejects.toThrow('Conflicto')
    await expect(a.sharing.member(id)).rejects.toThrow('conflicto')
    expect((await a.sharing.recoveryPhrase(id)).recovery_phrase).toBe(phrase)
    await a.sharing.importInvitation(await a.sharing.invitation(id))
    await expect(a.sharing.member(id)).rejects.toThrow('conflicto')
    await a.sharing.recover(id, phrase)
    await b.sharing.importInvitation(await a.sharing.invitation(id))
    expect((await b.sharing.get(id)).policy_hash).toBe((await a.sharing.get(id)).policy_hash)
    const rejectedBranchMember = (await d.sharing.identity()).id
    expect((await b.sharing.get(id)).policy.members.some(m => m.identity.id === rejectedBranchMember)).toBe(false)
    await copy(b, a, id)
    const fresh = await hub('Recuperado')
    await restoreProject(fresh.sharing, await exportProject(a.sharing, id), phrase)
    expect((await fresh.store.list({ kind: 'note', project_id: id })).items[0]!.title).toBe('Trabajo de otra rama')
  })
})
