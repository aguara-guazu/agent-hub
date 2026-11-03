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
}

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
 * True when the project is a usable shared project of this hub (enabled, no administration conflict, backed by a project
 * entity) and every hub in `hubIds` is an active member of its current policy.
 */
export async function sharedProjectUsable(db: Sql, projectId: string, hubIds: string[]): Promise<boolean> {
  const row = (await db.query(`SELECT v.document AS policy FROM shared_projects p
    JOIN shared_policies v ON v.hash=p.policy_hash JOIN entities e ON e.id=p.id AND e.kind='project'
    WHERE p.id=$1 AND p.enabled=1 AND p.conflict IS NULL`, [projectId]))[0]
  const policy = row ? policyOf(row.policy) : null
  if (!policy?.members) return false
  const now = Date.now()
  return hubIds.every(hubId => active(policy.members.find(member => member.identity.id === hubId), now))
}

/**
 * Local decision on the project of a channel after a membership change. A stored project survives only while this hub
 * is still an active member of that shared project; otherwise it is replaced by `requested` when that one is usable
 * here, or cleared. Remote data never invalidates a local association and nothing is chosen by heuristic.
 */
export async function settleChannelProject(db: Sql, channelId: string, localHubId: string, requested: string | null = null): Promise<string | null> {
  const row = (await db.query("SELECT project_id FROM chat_channels WHERE id=$1 AND kind=$2", [channelId, INTERHUB_CHANNEL_KIND]))[0]
  if (!row) return null
  const current = row.project_id ? String(row.project_id) : null
  const settled = current && await sharedProjectUsable(db, current, [localHubId]) ? current
    : requested && await sharedProjectUsable(db, requested, [localHubId]) ? requested : null
  if (settled !== current) await db.query("UPDATE chat_channels SET project_id=$2,updated_at=now() WHERE id=$1", [channelId, settled])
  return settled
}

/** The session is the current, open leader of the local hub in the channel. */
export async function isLocalHubLeader(sql: Sql, channelId: string, localHubId: string, sessionId: string): Promise<boolean> {
  return Boolean((await sql.query(`SELECT 1 FROM interhub_members m JOIN chat_sessions s ON s.id=m.leader_session_id
    WHERE m.channel_id=$1 AND m.hub_id=$2 AND m.removed_at IS NULL AND m.leader_session_id=$3 AND s.closed_at IS NULL AND s.removed_at IS NULL`, [channelId, localHubId, sessionId]))[0])
}

/** Hubs and candidates of one channel, or null when it is not an inter-hub channel outside the trash. */
async function evidence(db: Sql, channelId: string, localHubId: string) {
  const channel = (await db.query("SELECT id,project_id FROM chat_channels WHERE id=$1 AND kind=$2 AND deleted_at IS NULL", [channelId, INTERHUB_CHANNEL_KIND]))[0]
  if (!channel) return null
  const hubs = await channelHubs(db, channelId, localHubId)
  return { projectId: channel.project_id ? String(channel.project_id) : null, hubs, candidates: await candidateProjects(db, hubs) }
}

/** Inter-hub channels without project anywhere in this hub, archived and closed ones included, trash excluded. */
export async function listOrphans(db: Sql, localHubId: () => Promise<string>): Promise<InterhubOrphanChannel[]> {
  const rows = await db.query("SELECT id,name,created_at,archived_at,closed_at FROM chat_channels WHERE kind=$1 AND project_id IS NULL AND deleted_at IS NULL ORDER BY updated_at DESC,id", [INTERHUB_CHANNEL_KIND])
  const result: InterhubOrphanChannel[] = []
  // The hub identity is created on first use; an installation without orphan channels must not trigger that.
  if (!rows.length) return result
  const local = await localHubId()
  for (const row of rows) {
    const hubs = await channelHubs(db, String(row.id), local)
    result.push({ channel_id: String(row.id), name: String(row.name), created_at: String(row.created_at),
      archived_at: row.archived_at ? String(row.archived_at) : null, closed_at: row.closed_at ? String(row.closed_at) : null,
      hubs, candidates: await candidateProjects(db, hubs) })
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
      if (found.candidates.length !== 1) { result.unresolved.push({ channel_id: channelId, candidates: found.candidates.map(c => c.project_id) }); return }
      const projectId = found.candidates[0]!.project_id
      const updated = await sql.query("UPDATE chat_channels SET project_id=$2,updated_at=now() WHERE id=$1 AND project_id IS NULL AND deleted_at IS NULL RETURNING id", [channelId, projectId])
      if (updated.length) result.resolved.push({ channel_id: channelId, project_id: projectId })
    })
  }
  return result
}

/**
 * Explicit assignment by the current local leader of the channel. The project must be one of the evidence candidates;
 * a channel that already has a project is never reassigned.
 */
export async function assignProject(db: TransactionalDatabase, localHubId: string, callerId: string, channelId: string, projectId: string) {
  // Leadership, membership policies and the write are decided inside one transaction.
  return db.transaction(async sql => {
    const channel = (await sql.query("SELECT id,project_id,leader_id FROM chat_channels WHERE id=$1 AND kind=$2 AND deleted_at IS NULL", [channelId, INTERHUB_CHANNEL_KIND]))[0]
    check(channel, "Canal entre hubs inexistente.", 404)
    check(!channel.project_id, "El canal ya pertenece a un proyecto.", 409)
    check(channel.leader_id === callerId && await isLocalHubLeader(sql, channelId, localHubId, callerId), "Sólo el líder de tu hub en el canal puede asignarle un proyecto.", 403)
    const found = await evidence(sql, channelId, localHubId)
    check(found?.candidates.some(candidate => candidate.project_id === projectId), "El proyecto no es compartido con todos los hubs activos del canal.", 422)
    const updated = await sql.query("UPDATE chat_channels SET project_id=$2,updated_at=now() WHERE id=$1 AND project_id IS NULL AND deleted_at IS NULL RETURNING id", [channelId, projectId])
    check(updated.length, "El canal ya pertenece a un proyecto.", 409)
    return { channel_id: channelId, project_id: projectId }
  })
}
