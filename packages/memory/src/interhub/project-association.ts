import { INTERHUB_CHANNEL_KIND } from "@agenthub/shared"
import { check } from "../contracts.js"
import type { Sql } from "../database.js"
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

/** Hubs and candidates of one channel, or null when it is not an inter-hub channel outside the trash. */
async function evidence(db: Sql, channelId: string, localHubId: string) {
  const channel = (await db.query("SELECT id,project_id FROM chat_channels WHERE id=$1 AND kind=$2 AND deleted_at IS NULL", [channelId, INTERHUB_CHANNEL_KIND]))[0]
  if (!channel) return null
  const hubs = await channelHubs(db, channelId, localHubId)
  return { projectId: channel.project_id ? String(channel.project_id) : null, hubs, candidates: await candidateProjects(db, hubs) }
}

/** Inter-hub channels without project anywhere in this hub, archived and closed ones included, trash excluded. */
export async function listOrphans(db: Sql, localHubId: string): Promise<InterhubOrphanChannel[]> {
  const rows = await db.query("SELECT id,name,created_at,archived_at,closed_at FROM chat_channels WHERE kind=$1 AND project_id IS NULL AND deleted_at IS NULL ORDER BY updated_at DESC,id", [INTERHUB_CHANNEL_KIND])
  const result: InterhubOrphanChannel[] = []
  for (const row of rows) {
    const hubs = await channelHubs(db, String(row.id), localHubId)
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
export async function backfillProjects(db: Sql, localHubId: string, options: { channelId?: string } = {}): Promise<InterhubBackfillResult> {
  const result: InterhubBackfillResult = { resolved: [], unresolved: [] }
  const ids = options.channelId
    ? [options.channelId]
    : (await db.query("SELECT id FROM chat_channels WHERE kind=$1 AND project_id IS NULL AND deleted_at IS NULL ORDER BY id", [INTERHUB_CHANNEL_KIND])).map(row => String(row.id))
  for (const channelId of ids) {
    const found = await evidence(db, channelId, localHubId)
    if (!found || found.projectId) continue
    if (found.candidates.length !== 1) { result.unresolved.push({ channel_id: channelId, candidates: found.candidates.map(c => c.project_id) }); continue }
    const projectId = found.candidates[0]!.project_id
    const updated = await db.query("UPDATE chat_channels SET project_id=$2,updated_at=now() WHERE id=$1 AND project_id IS NULL AND deleted_at IS NULL RETURNING id", [channelId, projectId])
    if (updated.length) result.resolved.push({ channel_id: channelId, project_id: projectId })
  }
  return result
}

/**
 * Explicit assignment by the current local leader of the channel. The project must be one of the evidence candidates;
 * a channel that already has a project is never reassigned.
 */
export async function assignProject(db: Sql, localHubId: string, callerId: string, channelId: string, projectId: string) {
  const channel = (await db.query("SELECT id,project_id,leader_id FROM chat_channels WHERE id=$1 AND kind=$2 AND deleted_at IS NULL", [channelId, INTERHUB_CHANNEL_KIND]))[0]
  check(channel, "Canal entre hubs inexistente.", 404)
  check(!channel.project_id, "El canal ya pertenece a un proyecto.", 409)
  const leads = (await db.query(`SELECT 1 FROM interhub_members m JOIN chat_sessions s ON s.id=m.leader_session_id
    WHERE m.channel_id=$1 AND m.hub_id=$2 AND m.removed_at IS NULL AND m.leader_session_id=$3 AND s.closed_at IS NULL AND s.removed_at IS NULL`, [channelId, localHubId, callerId]))[0]
  check(channel.leader_id === callerId && leads, "Sólo el líder de tu hub en el canal puede asignarle un proyecto.", 403)
  const found = await evidence(db, channelId, localHubId)
  check(found?.candidates.some(candidate => candidate.project_id === projectId), "El proyecto no es compartido con todos los hubs activos del canal.", 422)
  const updated = await db.query("UPDATE chat_channels SET project_id=$2,updated_at=now() WHERE id=$1 AND project_id IS NULL AND deleted_at IS NULL RETURNING id", [channelId, projectId])
  check(updated.length, "El canal ya pertenece a un proyecto.", 409)
  return { channel_id: channelId, project_id: projectId }
}
