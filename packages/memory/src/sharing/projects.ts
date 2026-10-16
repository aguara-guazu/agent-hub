import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { check, parse } from '../contracts.js'
import { Vault } from '../config.js'
import { requireEntity, type MemoryStore } from '../store.js'
import { digest, identity, publicIdentity, recovery, signature, validSignature, seal, unseal, randomKey, type Identity, type PublicIdentity } from './crypto.js'
import { active, genesisSchema, invitationSchema, withoutSignature, type Genesis, type Member, type Policy } from './schema.js'

export const LEASE_MS = 14 * 24 * 60 * 60 * 1000
export class SharedProjects {
  readonly vault: Vault
  constructor(readonly store: MemoryStore) { this.vault = new Vault(store.directory) }
  async identity(): Promise<Identity> {
    let stored = this.vault.read<{ seed: string; name: string }>('sharing-identity')
    if (!stored) stored = await this.store.db.transaction(async () => {
      // The UI and worker run in separate processes. Serialize first creation so
      // neither can overwrite the other's identity after it has signed an event.
      const existing = this.vault.read<{ seed: string; name: string }>('sharing-identity')
      if (existing) return existing
      const created = { seed: randomKey(), name: 'Mi Hub' }; this.vault.save('sharing-identity', created); return created
    })
    return identity(stored.seed, stored.name)
  }
  async rename(name: string) { const who = await this.identity(); this.vault.save('sharing-identity', { seed: who.seed, name }); return publicIdentity(await this.identity()) }
  async get(id: string) {
    const row = (await this.store.db.query('SELECT p.*,v.document AS policy FROM shared_projects p JOIN shared_policies v ON v.hash=p.policy_hash WHERE p.id=$1', [id]))[0]
    check(row, 'Proyecto compartido inexistente', 404)
    return row as { id: string; genesis: Genesis; policy: Policy; policy_hash: string; enabled: boolean; conflict: string | null }
  }
  async member(id: string, write = false) {
    const project = await this.get(id), who = await this.identity(), member = project.policy.members.find(m => m.identity.id === who.id)
    check(!project.conflict, 'Hay un conflicto de administración; revisalo antes de publicar', 409)
    check(active(member), 'El acceso al proyecto venció o fue revocado; pedí una nueva invitación', 403)
    if (write) check(member!.role !== 'reader', 'El rol reader no puede publicar', 403)
    return { project, who, member: member! }
  }
  async keys(id: string, who?: Identity): Promise<Record<string, string>> {
    const project = await this.get(id), me = who ?? await this.identity(), envelope = project.policy.keys[me.id]
    check(envelope, 'No hay claves de este proyecto para esta identidad', 403)
    return parse(z.record(z.string(), z.string()), await unseal(envelope, me, `project-keys:${id}`))
  }
  private async openRecoveryPhrase(genesis: Genesis, policy: Policy, who: Identity) {
    const envelope = policy.recovery_keys[who.id]
    check(envelope, 'Falta la recuperación cifrada del owner', 422)
    const phrase = parse(z.string().max(500), await unseal(envelope, who, `project-recovery:${genesis.id}`))
    const root = await recovery(phrase)
    check(root.identity.id === genesis.recovery.id, 'La frase no pertenece al proyecto', 403)
    return root.phrase
  }
  async recoveryPhrase(projectId: string) {
    const project = await this.get(projectId), who = await this.identity()
    const member = project.policy.members.find(m => m.identity.id === who.id)
    // Reading remains available during a policy conflict so an owner can recover authority.
    check(active(member) && member!.role === 'owner', 'Sólo los owners pueden ver la frase de recuperación', 403)
    const phrase = await this.openRecoveryPhrase(project.genesis, project.policy, who)
    return { recovery_phrase: phrase }
  }
  async create(projectId: string) {
    const entity = await requireEntity(this.store.db, projectId, 'project')
    check(!(await this.store.db.query('SELECT id FROM shared_projects WHERE id=$1', [projectId])).length, 'El proyecto ya está compartido', 409)
    const me = await this.identity(), root = await recovery(), now = new Date().toISOString()
    const unsigned = { id: projectId, title: entity.title, description: String(entity.data.description ?? '').slice(0, 8000), recovery: publicIdentity(root.identity), owner: publicIdentity(me), created_at: now }
    const genesis: Genesis = { ...unsigned, signature: signature(unsigned, root.identity) }
    const policy = await this.makePolicy(genesis, null, [{ identity: publicIdentity(me), role: 'owner', invite: true, expires_at: null, revoked: false }], me, {}, root.phrase)
    await this.importInvitation({ format: 'agenthub-invitation-v1', genesis, policies: [policy] })
    return { project_id: projectId, recovery_phrase: root.phrase, identity: publicIdentity(me) }
  }
  async makePolicy(genesis: Genesis, previous: Policy | null, members: Member[], signer: Identity, oldKeys: Record<string, string>, recoveryPhrase?: string): Promise<Policy> {
    check(members.some(m => m.role === 'owner' && !m.revoked), 'El proyecto necesita un owner')
    const now = new Date().toISOString(), epoch = randomUUID(), keys = { ...oldKeys, [epoch]: randomKey() }
    const envelopes: Policy['keys'] = {}
    for (const recipient of [...members.filter(m => active(m)).map(m => m.identity), genesis.recovery]) envelopes[recipient.id] = await seal(keys, recipient, `project-keys:${genesis.id}`)
    const canCheckpoint = signer.id === genesis.recovery.id || previous?.members.some(m => m.identity.id === signer.id && m.role === 'owner')
    let recoveryKeys = previous?.recovery_keys
    const phrase = recoveryPhrase ?? (previous && canCheckpoint ? await this.openRecoveryPhrase(genesis, previous, signer) : null)
    if (phrase) {
      const root = await recovery(phrase)
      check(root.identity.id === genesis.recovery.id, 'La frase no pertenece al proyecto', 403)
      recoveryKeys = {}
      for (const owner of members.filter(m => active(m) && m.role === 'owner'))
        recoveryKeys[owner.identity.id] = await seal(root.phrase, owner.identity, `project-recovery:${genesis.id}`)
    }
    check(recoveryKeys, 'La política requiere recuperación cifrada', 422)
    const localHistory = previous && canCheckpoint ? (await this.store.db.query<{ id: string }>('SELECT id FROM shared_events WHERE project_id=$1 ORDER BY id', [genesis.id])).map(r => r.id) : []
    const history = [...new Set([...(previous?.history ?? []), ...localHistory])].sort()
    const body = { project: genesis.id, revision: previous ? previous.revision + 1 : 0, parent: previous ? digest(previous) : null,
      issuer: signer.id, epoch, created_at: now, members, keys: envelopes, recovery_keys: recoveryKeys, history, supersedes: [] as string[] }
    return { ...body, signature: signature(body, signer) }
  }
  validatePolicy(genesis: Genesis, next: Policy, previous: Policy | null) {
    const instant = Date.parse(next.created_at)
    check(next.project === genesis.id && instant <= Date.now() + 300_000, 'Política inválida')
    check(new Set(next.members.map(m => m.identity.id)).size === next.members.length, 'Miembro repetido')
    check(next.members.some(m => active(m, instant) && m.role === 'owner'), 'Falta owner')
    check(next.recovery_keys, 'La política requiere recuperación cifrada', 422)
    const owners = next.members.filter(m => active(m, instant) && m.role === 'owner').map(m => m.identity.id).sort()
    check(digest(Object.keys(next.recovery_keys).sort()) === digest(owners), 'La recuperación debe estar cifrada exclusivamente para los owners', 403)
    for (const m of next.members) {
      check(m.role !== 'reader' || !m.invite, 'Reader no puede invitar')
      check(m.role !== 'owner' || m.expires_at === null, 'Owner no vence por inactividad')
      check(m.role === 'owner' || !!m.expires_at && Date.parse(m.expires_at) <= instant + LEASE_MS + 1000, 'La membresía excede 14 días')
    }
    const root = next.issuer === genesis.recovery.id
    check(root || next.supersedes.length === 0, 'Sólo la recuperación puede resolver ramas de permisos', 403)
    const issuer = previous?.members.find(m => m.identity.id === next.issuer)
    const signingIdentity = root ? genesis.recovery : previous ? issuer?.identity : genesis.owner
    check(signingIdentity && validSignature(withoutSignature(next), next.signature, signingIdentity), 'Firma de membresía inválida', 403)
    check(next.revision === (previous ? previous.revision + 1 : 0) && next.parent === (previous ? digest(previous) : null), 'Cadena de permisos inválida')
    if (!previous) {
      check(next.issuer === genesis.owner.id && next.members.length === 1 && next.members[0]!.identity.id === genesis.owner.id && next.members[0]!.role === 'owner', 'Membresía inicial inválida')
    } else if (!root) {
      check(instant >= Date.parse(previous.created_at), 'La política no puede preceder a su padre')
      check(active(issuer, instant) && (issuer!.role === 'owner' || issuer!.invite), 'El firmante no puede administrar miembros', 403)
      if (issuer!.role !== 'owner') {
        check(digest(next.recovery_keys) === digest(previous.recovery_keys), 'La delegación no permite modificar la recuperación', 403)
        check(digest(next.history) === digest(previous.history), 'La delegación no permite autorizar aportes históricos', 403)
        // Delegated invitations can add/renew readers and maintainers, never alter existing authority or revoke.
        for (const old of previous.members) {
          const updated = next.members.find(m => m.identity.id === old.identity.id)
          check(updated && digest(updated) === digest(old), 'La delegación sólo permite agregar miembros', 403)
        }
        for (const added of next.members.filter(m => !previous.members.some(p => p.identity.id === m.identity.id))) {
          check(added.role !== 'owner' && !added.invite && !added.revoked, 'No podés delegar ni conceder owner', 403)
        }
      }
    }
  }
  async invitation(projectId: string) {
    const project = await this.get(projectId)
    const policies: Policy[] = [], seen = new Set<string>()
    let current: string | null = project.policy_hash
    while (current) {
      check(!seen.has(current), 'Ciclo en permisos'); seen.add(current)
      const row: { document: Policy } | undefined = (await this.store.db.query<{ document: Policy }>('SELECT document FROM shared_policies WHERE hash=$1 AND project_id=$2', [current, projectId]))[0]
      check(row, 'Cadena de permisos incompleta')
      policies.unshift(row.document); current = row.document.parent
    }
    const proofs = (await this.store.db.query<{ document: Policy }>('SELECT document FROM shared_policies WHERE project_id=$1 ORDER BY revision,hash', [projectId]))
      .map(r => r.document).filter(p => !seen.has(digest(p)))
    return { format: 'agenthub-invitation-v1' as const, genesis: project.genesis, policies, proofs }
  }
  async importInvitation(raw: unknown, recovered = false) {
    const packet = parse(invitationSchema, raw), genesis = parse(genesisSchema, packet.genesis)
    check(validSignature(withoutSignature(genesis), genesis.signature, genesis.recovery), 'Identidad del proyecto inválida', 403)
    let previous: Policy | null = null
    for (const policy of packet.policies) { this.validatePolicy(genesis, policy, previous); previous = policy }
    const verified = new Map(packet.policies.map(p => [digest(p), p]))
    for (const proof of [...packet.proofs].sort((a, b) => a.revision - b.revision)) {
      const parent = proof.parent ? verified.get(proof.parent) : null
      check(!proof.parent || parent, 'Falta la cadena de una rama histórica')
      this.validatePolicy(genesis, proof, parent ?? null); verified.set(digest(proof), proof)
    }
    const latest = previous!, me = await this.identity()
    // Possession of an invitation is not authority: it must name this cryptographic identity.
    check(recovered || latest.members.some(m => m.identity.id === me.id), 'La invitación pertenece a otra identidad', 403)
    const existing = (await this.store.db.query('SELECT genesis,policy_hash FROM shared_projects WHERE id=$1', [genesis.id]))[0]
    if (existing) {
      check(digest(existing.genesis) === digest(genesis), 'Otro proyecto usa este identificador', 409)
      const current = await this.get(genesis.id)
      const resolves = latest.issuer === genesis.recovery.id && latest.supersedes.includes(current.policy_hash)
      const known = await this.invitation(genesis.id)
      if (!resolves && (current.policy_hash === digest(latest) || known.policies.some(p => p.parent === digest(latest) || p.supersedes.includes(digest(latest))))) return { project_id: genesis.id, unchanged: true }
      check(!current.conflict || resolves, 'Conflicto de administración pendiente de recuperación', 409)
      if (!packet.policies.some(p => digest(p) === current.policy_hash) && !resolves) {
        // Retain the verified alternate branch so recovery can explicitly supersede it and unwrap its old epochs.
        for (const p of verified.values()) await this.store.db.query('INSERT INTO shared_policies(hash,project_id,revision,document) VALUES($1,$2,$3,$4) ON CONFLICT(hash) DO NOTHING', [digest(p), genesis.id, p.revision, JSON.stringify(p)])
        await this.store.db.query('UPDATE shared_projects SET conflict=$2 WHERE id=$1', [genesis.id, 'Dos administradores publicaron políticas incompatibles. Conservá ambas copias y elegí una rama con la recuperación.'])
        throw new Error('Conflicto de administración; no se reemplazaron permisos existentes')
      }
    }
    await this.store.db.transaction(async sql => {
      const concurrent = (await sql.query('SELECT policy_hash FROM shared_projects WHERE id=$1', [genesis.id]))[0]
      if (concurrent && concurrent.policy_hash !== existing?.policy_hash) {
        check(packet.policies.some(p => digest(p) === concurrent.policy_hash) || latest.issuer === genesis.recovery.id && latest.supersedes.includes(concurrent.policy_hash), 'La membresía cambió durante la operación; sincronizá y reintentá', 409)
      }
      const entity = (await sql.query('SELECT kind FROM entities WHERE id=$1', [genesis.id]))[0]
      check(!entity || entity.kind === 'project', 'El identificador ya pertenece a otra entidad', 409)
      if (!entity) await sql.query("INSERT INTO entities(id,kind,title,data) VALUES($1,'project',$2,$3)", [genesis.id, genesis.title, JSON.stringify({ description: genesis.description, remote_processing: false })])
      await sql.query(`INSERT INTO shared_projects(id,genesis,policy_hash) VALUES($1,$2,$3)
        ON CONFLICT(id) DO UPDATE SET policy_hash=excluded.policy_hash,conflict=NULL,updated_at=now()`, [genesis.id, JSON.stringify(genesis), digest(latest)])
      for (const policy of verified.values()) await sql.query('INSERT INTO shared_policies(hash,project_id,revision,document) VALUES($1,$2,$3,$4) ON CONFLICT(hash) DO NOTHING', [digest(policy), genesis.id, policy.revision, JSON.stringify(policy)])
    })
    return { project_id: genesis.id, role: latest.members.find(m => m.identity.id === me.id)?.role ?? null }
  }
  async changeMember(projectId: string, target: PublicIdentity, role: Member['role'], invite: boolean, revoke = false) {
    const { project, who, member } = await this.member(projectId)
    check(member.role === 'owner' || member.invite && !revoke && role !== 'owner' && !invite, 'No podés conceder estos permisos', 403)
    const members = project.policy.members.filter(m => m.identity.id !== target.id)
    members.push({ identity: target, role, invite, revoked: revoke, expires_at: role === 'owner' ? null : new Date(Date.now() + LEASE_MS).toISOString() })
    const next = await this.makePolicy(project.genesis, project.policy, members, who, await this.keys(projectId))
    const packet = await this.invitation(projectId); packet.policies.push(next)
    await this.importInvitation(packet)
    return packet
  }
  async join(raw: unknown, phrase?: string) {
    if (!phrase) return this.importInvitation(raw)
    const packet = parse(invitationSchema, raw), root = await recovery(phrase)
    check(root.identity.id === packet.genesis.recovery.id, 'La frase no pertenece al proyecto', 403)
    return this.store.db.transaction(async () => {
      await this.importInvitation(packet, true)
      return this.recover(packet.genesis.id, phrase)
    })
  }
  async renew(projectId: string, memberId: string) {
    const project = await this.get(projectId), target = project.policy.members.find(m => m.identity.id === memberId)
    check(active(target), 'El acceso venció; necesita nueva invitación', 403)
    if (target!.role === 'owner' || Date.parse(target!.expires_at!) > Date.now() + LEASE_MS / 2) return false
    await this.changeMember(projectId, target!.identity, target!.role, target!.invite)
    return true
  }
  async recover(projectId: string, phrase: string) {
    const root = await recovery(phrase), project = await this.get(projectId), who = await this.identity()
    check(root.identity.id === project.genesis.recovery.id, 'La frase no pertenece al proyecto', 403)
    const members = project.policy.members.filter(m => m.identity.id !== who.id)
    members.push({ identity: publicIdentity(who), role: 'owner', invite: true, expires_at: null, revoked: false })
    const keys = await this.keys(projectId, root.identity)
    const branches = await this.store.db.query<{ hash: string; document: Policy }>('SELECT hash,document FROM shared_policies WHERE project_id=$1', [projectId])
    for (const branch of branches) {
      const wrapped = branch.document.keys[root.identity.id]
      if (wrapped) Object.assign(keys, await unseal(wrapped, root.identity, `project-keys:${projectId}`))
    }
    const next = await this.makePolicy(project.genesis, project.policy, members, root.identity, keys, root.phrase)
    next.supersedes = branches.map(b => b.hash)
    next.signature = signature(withoutSignature(next), root.identity)
    const packet = await this.invitation(projectId); packet.policies.push(next)
    await this.importInvitation(packet)
    await this.store.db.query('UPDATE shared_projects SET conflict=NULL WHERE id=$1', [projectId])
    return { project_id: projectId, role: 'owner' }
  }
}
