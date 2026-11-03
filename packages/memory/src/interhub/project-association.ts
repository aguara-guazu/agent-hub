import { INTERHUB_CHANNEL_KIND } from "@agenthub/shared"
import { check } from "../contracts.js"
import type { Sql, TransactionSql } from "../database.js"
import { active, type Policy } from "../sharing/schema.js"

/**
 * Association between a local inter-hub channel and a project of this hub. `chat_channels.project_id` is never carried
 * by the roster, so a copy created without an explicit project stays NULL and is invisible to every project tab. The
 * only evidence accepted here is the current policy of shared projects: a project is a candidate for a channel when
 * every active hub of the channel is an active member of that policy. Nothing here infers from agents, from the number
 * of local projects or from creation order, and a project_id that is already set is never read as wrong or replaced.
 */

export interface InterhubOrphanChannel {
  channel_id: string
  name: string
  created_at: string
  archived_at: string | null
  closed_at: string | null
  hubs: { id: string; name: string | null; is_local: boolean }[]
  candidates: { project_id: string; title: string }[]
  /** Why the channel lost its project; null when it was never unlinked or has been assigned again. */
  project_unlink_reason: InterhubUnlinkReason | null
}

export type InterhubUnlinkReason = "membership_expired" | "membership_revoked" | "project_unavailable"

export interface InterhubBackfillResult {
  resolved: { channel_id: string; project_id: string }[]
  /** Channels whose evidence is a tie or empty; they keep project_id NULL. */
  unresolved: { channel_id: string; candidates: string[] }[]
}

/**
 * Per-store hook that reconciles the projects of inter-hub channels. The inter-hub service registers itself so that code
 * outside it (shared-project import) reaches the same logging and change notification without importing the service.
 */
export const projectReconcilers = new WeakMap<object, () => Promise<void>>()

/** Database handle whose reads and writes of one decision must share a transaction. */
export interface TransactionalDatabase extends Sql {
  transaction<T>(fn: (sql: TransactionSql) => Promise<T>): Promise<T>
}

interface Candidate { project_id: string; title: string }

const policyOf = (value: unknown): Policy | null => {
  try { return (typeof value === "string" ? JSON.parse(value) : value) as Policy } catch { return null }
}
const identityName = (value: unknown) => {
  try {
    const identity = typeof value === "string" ? JSON.parse(value) : value
    return typeof identity?.name === "string" && identity.name.trim() ? String(identity.name) : null
  } catch { return null }
}

/** Active hubs of the channel with the local one flagged; removed hubs do not count as evidence. */
async function channelHubs(db: Sql, channelId: string, localHubId: string) {
  const rows = await db.query("SELECT hub_id,peer_identity FROM interhub_members WHERE channel_id=$1 AND removed_at IS NULL ORDER BY joined_at,hub_id", [channelId])
  return rows.map(row => ({ id: String(row.hub_id), name: identityName(row.peer_identity), is_local: row.hub_id === localHubId }))
}

/**
 * Shared projects usable as evidence: enabled, without an administration conflict and backed by a project entity.
 * The policy joined is the current one (`policy_hash`). At least one remote hub is required, otherwise a channel that
 * only its creator has joined would match every project the local hub shares.
 */
export async function candidateProjects(db: Sql, hubs: { id: string; is_local: boolean }[]): Promise<Candidate[]> {
  if (!hubs.some(hub => !hub.is_local)) return []
  const rows = await db.query(`SELECT p.id,e.title,v.document AS policy FROM shared_projects p
    JOIN shared_policies v ON v.hash=p.policy_hash JOIN entities e ON e.id=p.id AND e.kind='project'
    WHERE p.enabled=1 AND p.conflict IS NULL ORDER BY p.id`)
  const now = Date.now(), result: Candidate[] = []
  for (const row of rows) {
    const policy = policyOf(row.policy)
    if (!policy?.members) continue
    if (hubs.every(hub => active(policy.members.find(member => member.identity.id === hub.id), now))) result.push({ project_id: String(row.id), title: String(row.title) })
  }
  return result
}

/**
 * True when the project is a shared project of this hub (no administration conflict, backed by a project entity) and every
 * hub in `hubIds` is an active member of its current policy. A new association also requires the project to be enabled;
 * an association already stored does not, because a pause only switches synchronization off in this hub.
 */
export async function sharedProjectUsable(db: Sql, projectId: string, hubIds: string[], options: { enabled?: boolean } = {}): Promise<boolean> {
  const row = (await db.query(`SELECT v.document AS policy FROM shared_projects p
    JOIN shared_policies v ON v.hash=p.policy_hash JOIN entities e ON e.id=p.id AND e.kind='project'
    WHERE p.id=$1 AND p.conflict IS NULL${options.enabled === false ? "" : " AND p.enabled=1"}`, [projectId]))[0]
  const policy = row ? policyOf(row.policy) : null
  if (!policy?.members) return false
  const now = Date.now()
  return hubIds.every(hubId => active(policy.members.find(member => member.identity.id === hubId), now))
}

/**
 * Whether an association already stored is still valid for this hub, from its local policy only. A pause and an
 * administration conflict are recoverable states and keep it; it is lost when the project, its policy or its entity no
 * longer exist here, when this hub is not in the policy, or when its membership was revoked or expired.
 */
export async function storedAssociation(db: Sql, projectId: string, localHubId: string, now = Date.now()): Promise<{ valid: true } | { valid: false; reason: InterhubUnlinkReason }> {
  const row = (await db.query(`SELECT v.document AS policy FROM shared_projects p
    JOIN shared_policies v ON v.hash=p.policy_hash JOIN entities e ON e.id=p.id AND e.kind='project' WHERE p.id=$1`, [projectId]))[0]
  const policy = row ? policyOf(row.policy) : null
  const member = policy?.members?.find(candidate => candidate.identity.id === localHubId)
  if (!member) return { valid: false, reason: "project_unavailable" }
  if (member.revoked) return { valid: false, reason: "membership_revoked" }
  return active(member, now) ? { valid: true } : { valid: false, reason: "membership_expired" }
}

/** Removes the project of a channel and records why and which one, so the same project can be restored later. */
async function unlinkChannel(db: Sql, channelId: string, projectId: string, reason: InterhubUnlinkReason): Promise<boolean> {
  const updated = await db.query("UPDATE chat_channels SET project_id=NULL,updated_at=now() WHERE id=$1 AND project_id=$2 RETURNING id", [channelId, projectId])
  if (!updated.length) return false
  await db.query("UPDATE interhub_channels SET project_unlink_reason=$2,project_unlinked_id=$3,project_unlinked_at=$4 WHERE channel_id=$1", [channelId, reason, projectId, new Date().toISOString()])
  console.error(`interhub: project of channel ${channelId} unlinked (${reason})`)
  return true
}

/**
 * Called inside the transaction that deletes a project entity, before the row goes: the foreign key would set the channel
 * project to NULL without a trace. The channel keeps no project id to restore because the project no longer exists.
 * Returns the number of channels released.
 */
export async function releaseDeletedProject(db: Sql, projectId: string): Promise<number> {
  const rows = await db.query("SELECT id FROM chat_channels WHERE kind=$1 AND project_id=$2", [INTERHUB_CHANNEL_KIND, projectId])
  for (const row of rows) {
    await db.query("UPDATE chat_channels SET project_id=NULL,updated_at=now() WHERE id=$1", [row.id])
    await db.query("UPDATE interhub_channels SET project_unlink_reason='project_unavailable',project_unlinked_id=NULL,project_unlinked_at=$2 WHERE channel_id=$1", [row.id, new Date().toISOString()])
    console.error(`interhub: project of channel ${row.id} unlinked (project deleted)`)
  }
  return rows.length
}

/** Forgets the unlink record once the channel has a project again. */
const clearUnlink = (db: Sql, channelId: string) =>
  db.query("UPDATE interhub_channels SET project_unlink_reason=NULL,project_unlinked_id=NULL,project_unlinked_at=NULL WHERE channel_id=$1", [channelId])

/**
 * Local pass over the associations that already exist: each one whose policy no longer vouches for this hub is
 * unlinked. Remote data never takes part; only the local policy and clock do. Returns the unlinked channels.
 */
export async function unlinkInvalidProjects(db: TransactionalDatabase, localHubId: () => Promise<string>, options: { channelId?: string } = {}): Promise<{ channel_id: string; reason: InterhubUnlinkReason }[]> {
  const rows = await db.query("SELECT id,project_id FROM chat_channels WHERE kind=$1 AND project_id IS NOT NULL AND deleted_at IS NULL AND ($2 IS NULL OR id=$2)", [INTERHUB_CHANNEL_KIND, options.channelId ?? null])
  // The hub identity is created on first use; installations without assigned channels must not trigger that.
  if (!rows.length) return []
  const local = await localHubId(), unlinked: { channel_id: string; reason: InterhubUnlinkReason }[] = []
  for (const row of rows) {
    await db.transaction(async sql => {
      const state = await storedAssociation(sql, String(row.project_id), local)
      if (!state.valid && await unlinkChannel(sql, String(row.id), String(row.project_id), state.reason)) unlinked.push({ channel_id: String(row.id), reason: state.reason })
    })
  }
  return unlinked
}

/** Earliest future expiry of this hub's own membership in the projects of the assigned channels, as epoch milliseconds, or null. */
export async function nextLocalExpiry(db: Sql, localHubId: () => Promise<string>): Promise<number | null> {
  const rows = await db.query(`SELECT DISTINCT c.project_id,v.document AS policy FROM chat_channels c
    JOIN shared_projects p ON p.id=c.project_id JOIN shared_policies v ON v.hash=p.policy_hash
    WHERE c.kind=$1 AND c.project_id IS NOT NULL AND c.deleted_at IS NULL`, [INTERHUB_CHANNEL_KIND])
  if (!rows.length) return null
  const local = await localHubId(), now = Date.now()
  let earliest: number | null = null
  for (const row of rows) {
    const member = policyOf(row.policy)?.members?.find(candidate => candidate.identity.id === local)
    const expires = member?.expires_at ? Date.parse(member.expires_at) : NaN
    if (Number.isFinite(expires) && expires > now && (earliest === null || expires < earliest)) earliest = expires
  }
  return earliest
}

/**
 * Local decision on the project of a channel after a membership change. A stored project survives only while this hub
 * is still valid for this hub (see storedAssociation). `requested` (the local leader's choice) replaces an invalid one,
 * or fills a missing one, when this hub and the creator hub are both active members; otherwise an invalid project is
 * unlinked with its reason. Remote data never invalidates a local association and nothing is chosen by heuristic.
 */
export async function settleChannelProject(db: Sql, channelId: string, localHubId: string, creatorHubId: string, requested: string | null = null): Promise<string | null> {
  const row = (await db.query("SELECT project_id FROM chat_channels WHERE id=$1 AND kind=$2", [channelId, INTERHUB_CHANNEL_KIND]))[0]
  if (!row) return null
  const current = row.project_id ? String(row.project_id) : null
  const state = current ? await storedAssociation(db, current, localHubId) : null
  if (current && state?.valid) return current
  const replacement = requested && await sharedProjectUsable(db, requested, [localHubId, creatorHubId]) ? requested : null
  if (current && state && !state.valid) {
    if (replacement) {
      await db.query("UPDATE chat_channels SET project_id=$2,updated_at=now() WHERE id=$1", [channelId, replacement])
      await clearUnlink(db, channelId)
      console.error(`interhub: project of channel ${channelId} replaced by the requested one (${state.reason})`)
    } else await unlinkChannel(db, channelId, current, state.reason)
    return replacement
  }
  if (replacement) {
    await db.query("UPDATE chat_channels SET project_id=$2,updated_at=now() WHERE id=$1", [channelId, replacement])
    await clearUnlink(db, channelId)
  }
  return replacement
}

/** The session is the current, open leader of the local hub in the channel. */
export async function isLocalHubLeader(sql: Sql, channelId: string, localHubId: string, sessionId: string): Promise<boolean> {
  return Boolean((await sql.query(`SELECT 1 FROM interhub_members m JOIN chat_sessions s ON s.id=m.leader_session_id
    WHERE m.channel_id=$1 AND m.hub_id=$2 AND m.removed_at IS NULL AND m.leader_session_id=$3 AND s.closed_at IS NULL AND s.removed_at IS NULL`, [channelId, localHubId, sessionId]))[0])
}

/**
 * Hubs and candidates of one channel, or null when it is not an inter-hub channel outside the trash. `hint` is the project
 * the creator hub declared through a signed project event; while it exists no candidate is inferred.
 */
async function evidence(db: Sql, channelId: string, localHubId: string) {
  const channel = (await db.query(`SELECT c.id,c.project_id,i.creator_hub_id,i.shared_project_hint,i.project_unlinked_id FROM chat_channels c
    JOIN interhub_channels i ON i.channel_id=c.id WHERE c.id=$1 AND c.kind=$2 AND c.deleted_at IS NULL`, [channelId, INTERHUB_CHANNEL_KIND]))[0]
  if (!channel) return null
  const hubs = await channelHubs(db, channelId, localHubId)
  return { projectId: channel.project_id ? String(channel.project_id) : null, creatorHubId: String(channel.creator_hub_id),
    hint: channel.shared_project_hint && channel.creator_hub_id !== localHubId ? String(channel.shared_project_hint) : null,
    unlinked: channel.project_unlinked_id ? String(channel.project_unlinked_id) : null, hubs, candidates: await candidateProjects(db, hubs) }
}

/** Inter-hub channels without project anywhere in this hub, archived and closed ones included, trash excluded. */
export async function listOrphans(db: Sql, localHubId: () => Promise<string>): Promise<InterhubOrphanChannel[]> {
  const rows = await db.query(`SELECT c.id,c.name,c.created_at,c.archived_at,c.closed_at,i.shared_project_hint AS hint,i.project_unlink_reason AS reason FROM chat_channels c
    LEFT JOIN interhub_channels i ON i.channel_id=c.id WHERE c.kind=$1 AND c.project_id IS NULL AND c.deleted_at IS NULL ORDER BY c.updated_at DESC,c.id`, [INTERHUB_CHANNEL_KIND])
  const result: InterhubOrphanChannel[] = []
  // The hub identity is created on first use; an installation without orphan channels must not trigger that.
  if (!rows.length) return result
  const local = await localHubId()
  for (const row of rows) {
    const hubs = await channelHubs(db, String(row.id), local)
    // A project declared by the creator replaces the inferred candidates: the rule no longer applies while it exists.
    const declared = row.hint ? (await db.query("SELECT id,title FROM entities WHERE id=$1 AND kind='project'", [String(row.hint)]))[0] : null
    const candidates = row.hint ? declared ? [{ project_id: String(declared.id), title: String(declared.title) }] : [] : await candidateProjects(db, hubs)
    result.push({ channel_id: String(row.id), name: String(row.name), created_at: String(row.created_at),
      archived_at: row.archived_at ? String(row.archived_at) : null, closed_at: row.closed_at ? String(row.closed_at) : null,
      hubs, candidates, project_unlink_reason: row.reason ? String(row.reason) as InterhubUnlinkReason : null })
  }
  return result
}

/**
 * Assigns the single candidate of every orphan channel (or of `channelId`). The UPDATE only matches a NULL project_id,
 * so a concurrent explicit assignment wins and a second run changes nothing. Zero or several candidates leave the
 * channel orphan. Returns the assignments made so the caller can notify listeners.
 */
export async function backfillProjects(db: TransactionalDatabase, localHubId: () => Promise<string>, options: { channelId?: string } = {}): Promise<InterhubBackfillResult> {
  const result: InterhubBackfillResult = { resolved: [], unresolved: [] }
  const ids = options.channelId
    ? [options.channelId]
    : (await db.query("SELECT id FROM chat_channels WHERE kind=$1 AND project_id IS NULL AND deleted_at IS NULL ORDER BY id", [INTERHUB_CHANNEL_KIND])).map(row => String(row.id))
  // Resolved only when there is something to evaluate, so installations that never used inter-hub channels create no identity.
  if (!ids.length) return result
  const local = await localHubId()
  for (const channelId of ids) {
    // Evidence and write share one transaction so a policy change cannot slip between them.
    await db.transaction(async sql => {
      const found = await evidence(sql, channelId, local)
      if (!found || found.projectId) return
      // A declared project is applied once this hub and the creator are active members of an enabled policy; until then it
      // stays pending and the channel is not assigned by inference.
      if (found.hint) {
        if (!await sharedProjectUsable(sql, found.hint, [local, found.creatorHubId])) { result.unresolved.push({ channel_id: channelId, candidates: [found.hint] }); return }
        const applied = await sql.query("UPDATE chat_channels SET project_id=$2,updated_at=now() WHERE id=$1 AND project_id IS NULL AND deleted_at IS NULL RETURNING id", [channelId, found.hint])
        if (applied.length) { await clearUnlink(sql, channelId); result.resolved.push({ channel_id: channelId, project_id: found.hint }) }
        return
      }
      // Without a declaration the project the channel had is restored once it is valid again; until then no other one is chosen.
      if (found.unlinked) {
        if (!await sharedProjectUsable(sql, found.unlinked, [local, found.creatorHubId])) { result.unresolved.push({ channel_id: channelId, candidates: [found.unlinked] }); return }
        const restored = await sql.query("UPDATE chat_channels SET project_id=$2,updated_at=now() WHERE id=$1 AND project_id IS NULL AND deleted_at IS NULL RETURNING id", [channelId, found.unlinked])
        if (restored.length) { await clearUnlink(sql, channelId); result.resolved.push({ channel_id: channelId, project_id: found.unlinked }) }
        return
      }
      if (found.candidates.length !== 1) { result.unresolved.push({ channel_id: channelId, candidates: found.candidates.map(c => c.project_id) }); return }
      const projectId = found.candidates[0]!.project_id
      const updated = await sql.query("UPDATE chat_channels SET project_id=$2,updated_at=now() WHERE id=$1 AND project_id IS NULL AND deleted_at IS NULL RETURNING id", [channelId, projectId])
      if (updated.length) { await clearUnlink(sql, channelId); result.resolved.push({ channel_id: channelId, project_id: projectId }) }
    })
  }
  return result
}

/**
 * Explicit assignment by the current local leader of the channel. The project must be an enabled shared project in which
 * this hub and the creator hub are active members; a channel that already has a project is never reassigned.
 */
export async function assignProject(db: TransactionalDatabase, localHubId: string, callerId: string, channelId: string, projectId: string) {
  // Leadership, membership policies and the write are decided inside one transaction.
  return db.transaction(async sql => {
    const channel = (await sql.query("SELECT id,project_id,leader_id FROM chat_channels WHERE id=$1 AND kind=$2 AND deleted_at IS NULL", [channelId, INTERHUB_CHANNEL_KIND]))[0]
    check(channel, "Canal entre hubs inexistente.", 404)
    check(!channel.project_id, "El canal ya pertenece a un proyecto.", 409)
    check(channel.leader_id === callerId && await isLocalHubLeader(sql, channelId, localHubId, callerId), "Sólo el líder de tu hub en el canal puede asignarle un proyecto.", 403)
    const found = await evidence(sql, channelId, localHubId)
    check(found && await sharedProjectUsable(sql, projectId, [localHubId, found.creatorHubId]), "El proyecto no es un proyecto compartido activo de tu hub y del hub creador del canal.", 422)
    const updated = await sql.query("UPDATE chat_channels SET project_id=$2,updated_at=now() WHERE id=$1 AND project_id IS NULL AND deleted_at IS NULL RETURNING id", [channelId, projectId])
    check(updated.length, "El canal ya pertenece a un proyecto.", 409)
    await clearUnlink(sql, channelId)
    return { channel_id: channelId, project_id: projectId }
  })
}
