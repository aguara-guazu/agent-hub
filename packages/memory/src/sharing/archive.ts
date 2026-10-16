import { z } from 'zod'
import { check, parse } from '../contracts.js'
import { publicIdentity, publicIdentitySchema, randomKey, encrypt, decrypt, seal, unseal, signature, validSignature, recovery, boxSchema, envelopeSchema, digest, canonical } from './crypto.js'
import { active, eventSchema, invitationSchema, withoutSignature } from './schema.js'
import { SharedPublications } from './publications.js'

const archiveSchema = z.object({ format: z.literal('agenthub-project-encrypted-v1'), project: z.string().uuid(), created_at: z.string().datetime(),
  exporter: publicIdentitySchema, recovery: publicIdentitySchema, recipients: z.record(z.string(), envelopeSchema), body: boxSchema, signature: z.string().max(200) }).strict()
const snapshotSchema = z.object({ invitation: invitationSchema, events: z.array(eventSchema).max(100_000) }).strict()

export async function exportProject(sharing: SharedPublications, projectId: string) {
  const { project, who } = await sharing.member(projectId), key = randomKey(), purpose = `archive:${projectId}`
  const snapshot = await sharing.store.db.transaction(async () => {
    const [size] = await sharing.store.db.query('SELECT COALESCE(sum(length(document)),0) AS bytes FROM shared_events WHERE project_id=$1', [projectId])
    check(Number(size!.bytes) <= 115_000_000, 'Este proyecto supera el límite de respaldo de 115 MB')
    const events = await sharing.store.db.query<{ document: unknown }>(`SELECT document FROM shared_events WHERE project_id=$1
      AND (payload->>'kind' IN('publication','object','observation') OR (payload->>'kind'='message' AND payload->>'to_member' IS NULL AND payload->>'expires_at'>now())) ORDER BY seq`, [projectId])
    return { invitation: await sharing.invitation(projectId), events: events.map(e => e.document) }
  }, 'read')
  check(Buffer.byteLength(canonical(snapshot)) <= 115_000_000, 'Este proyecto supera el límite de respaldo de 115 MB')
  const unsigned = { format: 'agenthub-project-encrypted-v1' as const, project: projectId, created_at: new Date().toISOString(),
    exporter: publicIdentity(who), recovery: project.genesis.recovery,
    recipients: { [who.id]: await seal(key, who, purpose), [project.genesis.recovery.id]: await seal(key, project.genesis.recovery, purpose) },
    body: encrypt(snapshot, key, purpose) }
  return { ...unsigned, signature: signature(unsigned, who) }
}
export async function restoreProject(sharing: SharedPublications, raw: unknown, phrase?: string) {
  const archive = parse(archiveSchema, raw), who = await sharing.identity(), purpose = `archive:${archive.project}`
  check(validSignature(withoutSignature(archive), archive.signature, archive.exporter), 'Firma del respaldo inválida')
  const root = phrase ? (await recovery(phrase)).identity : null
  if (root) check(root.id === archive.recovery.id, 'La frase no pertenece al respaldo', 403)
  const recipient = root ?? who, envelope = archive.recipients[recipient.id]
  check(envelope, 'Este respaldo necesita la frase de recuperación del proyecto', 403)
  let snapshot: z.infer<typeof snapshotSchema>
  try { snapshot = parse(snapshotSchema, decrypt(archive.body, await unseal(envelope, recipient, purpose), purpose)) }
  catch { throw new Error('No se pudo abrir el respaldo: clave incorrecta o archivo alterado') }
  check(snapshot.invitation.genesis.id === archive.project && digest(snapshot.invitation.genesis.recovery) === digest(archive.recovery), 'El respaldo pertenece a otro proyecto')
  const last = snapshot.invitation.policies.at(-1)!
  check(active(last.members.find(m => m.identity.id === archive.exporter.id), Date.parse(archive.created_at)), 'El exportador no tenía acceso vigente', 403)
  // All database changes roll back on invalid events; existing policy chains can only advance, never roll back.
  await sharing.store.db.transaction(async () => {
    await sharing.importInvitation(snapshot.invitation, !!root)
    if (root) await sharing.recover(archive.project, phrase!)
    const current = await sharing.get(archive.project)
    // Signed archives carry historical data. Only the exported chain may authorize those historical entries.
    for (const event of snapshot.events) {
      check(event.project === archive.project, 'Aporte de otro proyecto en el respaldo')
      const historicalAuthor = last.members.find(m => m.identity.id === event.author)
      await sharing.receive(event, archive.exporter.id, active(historicalAuthor, Date.parse(archive.created_at)) && historicalAuthor!.role !== 'reader'
        ? { policy_hash: digest(last), policies: snapshot.invitation.policies.map(digest), exported_at: archive.created_at } : undefined)
    }
    if (root) {
      // Checkpoint restored history so revoked authors' old, verified contributions can be relayed to new members.
      await sharing.recover(archive.project, phrase!)
    }
    check(!current.conflict, 'El respaldo tiene conflictos de administración', 409)
  })
  // Original files use a separate cross-process lock; projections resume from the committed event log after a crash.
  while (await sharing.applyPending()) { /* Drain all restored publications, including projects larger than one batch. */ }
  return { project_id: archive.project, restored: true, recovered_as_owner: !!root, events: snapshot.events.length }
}
