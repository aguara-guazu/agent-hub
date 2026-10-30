import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { CHAT_MESSAGE_KINDS, CHAT_RESOLUTION_TEXT_MAX, type ChatResolution } from "@agenthub/shared"
import { check, id, MemoryError } from "./contracts.js"
import type { Sql } from "./database.js"
import type { MemoryStore } from "./store.js"
import { channelProjectId, recordAuthorityEvent, ACTIVE_TEAM_STATES } from "./chat-access.js"
import { writeAssociation } from "./channel-authority.js"

/** Sessions that are not agents: excluded from participant counts, mentions and agent listings. */
export const NON_AGENT_CLI_KINDS = ["hub"] as const
const nonAgent = NON_AGENT_CLI_KINDS.map(kind => `'${kind}'`).join(",")
export const AUTHOR_SOURCE_SQL = "CASE WHEN s.agent_id='agenthub-system' AND s.cli_kind='hub' THEN 'hub' ELSE 'agent' END"

export const messageKind = z.enum(CHAT_MESSAGE_KINDS)
const requestId = z.string().trim().min(1).max(200)
export const proposeResolutionShape = { thread_id: id, text: z.string().trim().min(1).max(CHAT_RESOLUTION_TEXT_MAX),
  agreed: z.array(z.string().min(8).max(200)).max(20).default([]), request_id: requestId }
export const settleResolutionShape = { thread_id: id, resolution_id: id, outcome: z.enum(["approved", "rerun"]),
  human_instruction: z.string().trim().min(1).max(2000), note: z.string().trim().min(1).max(1000).optional() }

/** Declared JSON columns arrive parsed; computed json_object()/json columns of subqueries may arrive as text. */
const asJson = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value ?? null
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const fail = (status: number, code: string, message: string): never => { throw new MemoryError(status, message, false, code) }
const activeStates = ACTIVE_TEAM_STATES.map(state => `'${state}'`).join(",")

async function hubSession(sql: Sql, channelId: string) {
  const sender = `hub-system:${channelId}`
  await sql.query(`INSERT OR IGNORE INTO chat_sessions(id,agent_id,key_hash,label,cli_kind,channel_id,state,event_at,closed_at)
    VALUES($1,'agenthub-system',$2,'Agent Hub','hub',$3,'offline',now(),now())`, [sender, hash(randomUUID()), channelId])
  return sender
}

/** Open agent sessions that follow a thread: its channel leader and its authors, except a displaced leader and the actor. */
async function threadAudience(sql: Sql, thread: Record<string, any>, exclude: string) {
  const rows = await sql.query(`SELECT DISTINCT s.id FROM chat_sessions s JOIN chat_channels c ON c.id=$2
    WHERE s.closed_at IS NULL AND s.removed_at IS NULL AND s.cli_kind NOT IN (${nonAgent}) AND s.nickname IS NOT NULL
    AND s.id IS NOT c.displaced_leader_id AND s.id<>$3
    AND (s.id=c.leader_id OR s.id IN (SELECT author_id FROM chat_messages WHERE thread_id=$1))`, [thread.id, thread.channel_id, exclude])
  return rows.map(row => String(row.id))
}

/** Hub system message in the thread, delivered to its audience. Keyed per resolution and outcome, so a retry posts nothing new. */
async function hubMessage(sql: Sql, thread: Record<string, any>, text: string, requestKey: string, exclude: string) {
  const sender = await hubSession(sql, thread.channel_id)
  if ((await sql.query("SELECT 1 FROM chat_messages WHERE author_id=$1 AND request_id=$2", [sender, requestKey])).length) return 0
  const message = (await sql.query("INSERT INTO chat_messages(id,thread_id,author_id,text,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
    [randomUUID(), thread.id, sender, text, requestKey, hash(text)]))[0]!
  const audience = await threadAudience(sql, thread, exclude)
  for (const recipient of audience) await sql.query("INSERT INTO chat_deliveries(message_id,recipient_id,response_required) VALUES($1,$2,0)", [message.id, recipient])
  await sql.query("UPDATE chat_threads SET updated_at=now(),archived_notice=0 WHERE id=$1", [thread.id])
  return audience.length
}

async function requireThread(sql: Sql, threadId: string) {
  const thread = (await sql.query("SELECT * FROM chat_threads WHERE id=$1", [threadId]))[0]
  if (!thread) return fail(404, "thread_not_found", "Hilo inexistente.")
  const channel = (await sql.query("SELECT * FROM chat_channels WHERE id=$1", [thread.channel_id]))[0]!
  if (channel.deleted_at) fail(404, "thread_not_found", "El canal del hilo está en la papelera.")
  if (channel.closed_at || (channel.kind === "virtual" && !channel.activated_at)) fail(409, "channel_unavailable", "El canal está cerrado o inactivo.")
  return { thread, channel }
}

/**
 * Who may propose and record resolutions: the leader of a plain channel, or the master of the active team the thread
 * belongs to. Only Hub rows decide it (leader_id, plan creator); a displaced leader is not a leader.
 */
async function coordinatesThread(sql: Sql, who: Record<string, any>, thread: Record<string, any>, channel: Record<string, any>) {
  const root = thread.team_root_thread_id ?? thread.id
  const plan = (await sql.query("SELECT id FROM chat_team_plans WHERE root_thread_id=$1", [root]))[0]
  if (plan) return (await sql.query(`SELECT 1 FROM chat_team_plans p JOIN chat_channels mc ON mc.id=p.master_channel_id
    WHERE p.id=$1 AND p.created_by=$2 AND p.state IN (${activeStates}) AND mc.leader_id=$2 AND mc.closed_at IS NULL`, [plan.id, who.id])).length > 0
  return channel.leader_id === who.id && (await writeAssociation(sql, who.id, channel.id)) === "leader"
}

export async function resolutionView(sql: Sql, row: Record<string, any> | undefined): Promise<ChatResolution | null> {
  if (!row) return null
  const agreed: string[] = asJson(row.agreed_session_ids) ?? []
  const labels = agreed.length ? await sql.query("SELECT id,label FROM chat_sessions WHERE id IN (SELECT value FROM json_each($1))", [JSON.stringify(agreed)]) : []
  const label = new Map(labels.map(item => [String(item.id), String(item.label)]))
  const proposer = (await sql.query("SELECT label FROM chat_sessions WHERE id=$1", [row.proposed_by]))[0]
  return { id: row.id, thread_id: row.thread_id, channel_id: row.channel_id, project_id: await channelProjectId(sql, row.channel_id), text: row.text, state: row.state,
    proposed_by: row.proposed_by, proposed_by_label: String(proposer?.label ?? ""), agreed_session_ids: agreed, agreed_labels: agreed.map(item => label.get(item) ?? item),
    agreed_count: agreed.length, participant_count: Number(row.participant_count), created_at: row.created_at, decided_at: row.decided_at ?? null,
    decided_by: row.decided_by ?? null, decision_source: row.decision_source ?? null, decision_note: row.decision_note ?? null, decision_entity_id: row.decision_entity_id ?? null }
}
export async function latestResolution(sql: Sql, threadId: string) {
  return resolutionView(sql, (await sql.query("SELECT * FROM chat_thread_resolutions WHERE thread_id=$1 ORDER BY created_at DESC,rowid DESC LIMIT 1", [threadId]))[0])
}

/** SQL columns for `chat_threads` items (alias t = thread); `debateFields` turns them into the contract shape. */
export const THREAD_DEBATE_COLUMNS = `(SELECT count(DISTINCT m.author_id) FROM chat_messages m JOIN chat_sessions a ON a.id=m.author_id WHERE m.thread_id=t.id AND a.cli_kind NOT IN (${nonAgent})) AS agent_count,
  (SELECT json_object('id',r.id,'text',r.text,'agreed_count',json_array_length(r.agreed_session_ids),'participant_count',r.participant_count,'created_at',r.created_at)
    FROM chat_thread_resolutions r WHERE r.thread_id=t.id AND r.state='pending') AS pending_resolution_json`
export function debateFields<T extends Record<string, any>>({ pending_resolution_json, ...row }: T) {
  const pending = asJson(pending_resolution_json)
  return { ...row, agent_count: Number(row.agent_count ?? 0), pending_resolution: pending,
    debate_state: pending ? "awaiting_decision" : row.state === "resolved" ? "resolved" : "open" }
}
/** SQL column for `chat_channels` items (alias c = channel). Team threads live in the master channel, so channel_id covers them. */
export const CHANNEL_DEBATE_COLUMNS = `(SELECT count(*) FROM chat_thread_resolutions r JOIN chat_threads rt ON rt.id=r.thread_id
  WHERE r.channel_id=c.id AND r.state='pending' AND rt.archived_notice=0) AS awaiting_decision`

/** MCP, coordinator only (see coordinatesThread). Never decides anything: the person does, in the coordinator's terminal. */
export async function proposeResolution(sql: Sql, who: Record<string, any>, input: { thread_id: string; text: string; agreed: string[]; request_id: string }) {
  const agreed = [...new Set([who.id, ...input.agreed])].sort()
  const prior = (await sql.query("SELECT * FROM chat_thread_resolutions WHERE proposed_by=$1 AND request_id=$2", [who.id, input.request_id]))[0]
  if (prior) {
    check(prior.thread_id === input.thread_id && prior.text === input.text && JSON.stringify(asJson(prior.agreed_session_ids)) === JSON.stringify(agreed),
      "request_id ya usado con otra propuesta.", 409)
    return resolutionView(sql, prior)
  }
  const { thread, channel } = await requireThread(sql, input.thread_id)
  check(await coordinatesThread(sql, who, thread, channel), "Sólo el líder del canal (o el master del equipo del hilo) propone la resolución; los demás opinan en el hilo.", 403)
  check(thread.state === "open", "Este hilo está resuelto; reabrilo antes de proponer una resolución.", 409)
  const authors = new Set((await sql.query(`SELECT DISTINCT m.author_id FROM chat_messages m JOIN chat_sessions a ON a.id=m.author_id
    WHERE m.thread_id=$1 AND a.cli_kind NOT IN (${nonAgent})`, [thread.id])).map(row => String(row.author_id)))
  for (const session of agreed) check(session === who.id || authors.has(session), "Cada agente de acuerdo debe haber participado en el hilo.", 400)
  const participants = authors.has(who.id) ? authors.size : authors.size + 1
  const superseded = await sql.query("UPDATE chat_thread_resolutions SET state='superseded',decided_at=now() WHERE thread_id=$1 AND state='pending' RETURNING id", [thread.id])
  const row = (await sql.query(`INSERT INTO chat_thread_resolutions(id,thread_id,channel_id,proposed_by,request_id,text,agreed_session_ids,participant_count)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [randomUUID(), thread.id, channel.id, who.id, input.request_id, input.text, JSON.stringify(agreed), participants]))[0]!
  await sql.query("UPDATE chat_threads SET updated_at=now(),archived_notice=0 WHERE id=$1", [thread.id])
  await recordAuthorityEvent(sql, { kind: "resolution_proposed", channel_id: channel.id, project_id: await channelProjectId(sql, channel.id), actor_session_id: who.id,
    reason: "Resolución propuesta por el coordinador del hilo", evidence: { thread_id: thread.id, resolution_id: row.id, agreed, participant_count: participants,
      superseded: superseded.map(item => item.id) } })
  return resolutionView(sql, row)
}

/**
 * MCP, coordinator only: records the answer the person gave in the coordinator's terminal. The Hub cannot see that
 * terminal, so this is an audited coordinator declaration (verbatim human_instruction), the same provenance as a team
 * launch; the UI never approves. approved ⇒ project decision + resolved thread; rerun ⇒ proposal set aside, debate reopened.
 */
export async function settleResolution(sql: Sql, store: MemoryStore, who: Record<string, any>,
  input: { thread_id: string; resolution_id: string; outcome: "approved" | "rerun"; human_instruction: string; note?: string | undefined }) {
  const resolution = (await sql.query("SELECT * FROM chat_thread_resolutions WHERE id=$1 AND thread_id=$2", [input.resolution_id, input.thread_id]))[0]
  if (!resolution) return fail(404, "resolution_not_found", "La propuesta no pertenece a este hilo.")
  if (resolution.state === input.outcome && resolution.decided_by === who.id) {
    const view = await resolutionView(sql, resolution)
    return { resolution: view!, decision: resolution.decision_entity_id ? { id: resolution.decision_entity_id } : null, notified: 0 }
  }
  if (resolution.state === "superseded") fail(409, "resolution_changed", "Esta propuesta fue reemplazada por otra; decidí sobre la vigente.")
  if (resolution.state !== "pending") fail(409, "resolution_decided", "Esta propuesta ya fue decidida.")
  const { thread, channel } = await requireThread(sql, input.thread_id)
  check(await coordinatesThread(sql, who, thread, channel), "Sólo el líder del canal (o el master del equipo del hilo) registra la decisión de la persona.", 403)
  const projectId = await channelProjectId(sql, channel.id)
  const agreed = asJson(resolution.agreed_session_ids)
  let decision: { id: string; title: string; project_id: string } | null = null
  if (input.outcome === "approved") {
    if (!projectId) fail(409, "no_project", "El canal no pertenece a un proyecto; no hay dónde registrar la decisión.")
    const fact = await store.create({ kind: "fact", title: resolution.text.slice(0, 180), project_ids: [projectId],
      data: { text: resolution.text, category: "decision", review_state: "accepted", origin: "collaboration", occurred_at: new Date().toISOString(),
        thread_id: thread.id, channel_id: channel.id, resolution_id: resolution.id, agreed_session_ids: agreed, recorded_by: who.id,
        decision_source: "coordinator_declaration", human_instruction: input.human_instruction, ...(input.note ? { note: input.note } : {}) } }, `agent:${who.id}`, sql)
    decision = { id: fact.id, title: fact.title, project_id: projectId! }
  }
  const updated = (await sql.query(`UPDATE chat_thread_resolutions SET state=$2,decided_at=now(),decided_by=$3,decision_source='coordinator_declaration',
    human_instruction=$4,decision_note=$5,decision_entity_id=$6 WHERE id=$1 AND state='pending' RETURNING *`,
  [resolution.id, input.outcome, who.id, input.human_instruction, input.note ?? null, decision?.id ?? null]))[0]
  check(updated, "La propuesta cambió durante la operación; volvé a leer el hilo.", 409)
  const notified = await hubMessage(sql, thread, input.outcome === "approved"
    ? `Agent Hub: ${who.label} recorded that the person approved the proposed resolution; it is project decision ${decision!.id} and this thread is resolved.\nResolution: ${resolution.text}${input.note ? `\nNote: ${input.note}` : ""}`
    : `Agent Hub: ${who.label} recorded that the person asked for another round; the proposed resolution was set aside and the debate continues here.${input.note ? `\nWhat to address: ${input.note}` : ""}`,
  `resolution:${resolution.id}:${input.outcome}`, who.id)
  if (input.outcome === "approved") {
    // The person's decision closes the debate even if agents still owed each other replies.
    await sql.query(`UPDATE chat_deliveries SET cancelled_at=now(),error='Hilo resuelto por decisión de la persona' WHERE response_required=1 AND response_message_id IS NULL
      AND cancelled_at IS NULL AND message_id IN (SELECT id FROM chat_messages WHERE thread_id=$1)`, [thread.id])
    await sql.query("UPDATE chat_threads SET state='resolved',updated_at=now() WHERE id=$1", [thread.id])
  } else await sql.query("UPDATE chat_threads SET state='open',updated_at=now() WHERE id=$1", [thread.id])
  await recordAuthorityEvent(sql, { kind: input.outcome === "approved" ? "resolution_approved" : "resolution_rerun", channel_id: channel.id, project_id: projectId,
    actor_session_id: who.id, target_session_id: resolution.proposed_by, reason: input.note ?? input.human_instruction,
    evidence: { source: "coordinator_declaration", human_instruction: input.human_instruction, thread_id: thread.id, resolution_id: resolution.id,
      decision_entity_id: decision?.id ?? null, agreed } })
  return { resolution: (await resolutionView(sql, updated))!, decision, notified }
}

export const pendingDebatesQuery = z.object({ project_id: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }).strict()
/** Person read only (UI): pending resolutions of live channels, newest first. */
export async function pendingDebates(sql: Sql, filter: z.infer<typeof pendingDebatesQuery>) {
  const base = `SELECT r.id AS resolution_id,r.thread_id,t.title AS thread_title,r.channel_id,c.name AS channel_name,
      COALESCE((SELECT master.project_id FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id JOIN chat_channels master ON master.id=p.master_channel_id
        WHERE m.channel_id=c.id ORDER BY p.created_at DESC LIMIT 1),c.project_id) AS project_id,
      r.text,json_array_length(r.agreed_session_ids) AS agreed_count,r.participant_count,s.label AS proposed_by_label,r.created_at,r.rowid AS position
    FROM chat_thread_resolutions r JOIN chat_threads t ON t.id=r.thread_id JOIN chat_channels c ON c.id=r.channel_id JOIN chat_sessions s ON s.id=r.proposed_by
    WHERE r.state='pending' AND c.deleted_at IS NULL AND t.archived_notice=0`
  const query = `SELECT d.*,e.title AS project_title FROM (${base}) d LEFT JOIN entities e ON e.id=d.project_id WHERE ($1 IS NULL OR d.project_id=$1)`
  const total = Number((await sql.query(`SELECT count(*) AS n FROM (${query})`, [filter.project_id ?? null]))[0]!.n)
  const items = await sql.query(`SELECT * FROM (${query}) ORDER BY created_at DESC,position DESC LIMIT $2 OFFSET $3`, [filter.project_id ?? null, filter.limit, filter.offset])
  return { items: items.map(({ position: _position, ...item }) => ({ ...item, agreed_count: Number(item.agreed_count), participant_count: Number(item.participant_count) })),
    total, limit: filter.limit, offset: filter.offset }
}
