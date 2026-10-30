import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { CHAT_CHANNEL_DESCRIPTION_MAX, CHAT_CHANNEL_NAME_MAX, CHAT_DECISION_NOTE_MAX, CHAT_MESSAGE_KINDS, CHAT_PERSON_MESSAGE_MAX, CHAT_RESOLUTION_TEXT_MAX,
  type ChatResolution } from "@agenthub/shared"
import { check, id, MemoryError } from "./contracts.js"
import type { Sql } from "./database.js"
import type { MemoryStore } from "./store.js"
import { channelProjectId, recordAuthorityEvent, sessionProjectId, ACTIVE_TEAM_STATES } from "./chat-access.js"
import { leaseActive, writeAssociation } from "./channel-authority.js"

/**
 * The person's voice in a channel. It is a closed system row: no session_key can ever hash to it and no gateway agent id
 * equals PERSON_AGENT_ID, so no MCP call resolves to it. Only the authenticated HTTP routes write as this author.
 */
export const PERSON_AGENT_ID = "agenthub-person"
export const PERSON_CLI_KIND = "person"
/** Sessions that are not agents: excluded from participant counts, mentions and agent listings. */
export const NON_AGENT_CLI_KINDS = ["hub", PERSON_CLI_KIND] as const
const nonAgent = NON_AGENT_CLI_KINDS.map(kind => `'${kind}'`).join(",")
export const AUTHOR_SOURCE_SQL = `CASE WHEN s.agent_id='agenthub-system' AND s.cli_kind='hub' THEN 'hub' WHEN s.agent_id='${PERSON_AGENT_ID}' AND s.cli_kind='${PERSON_CLI_KIND}' THEN 'person' ELSE 'agent' END`

export const messageKind = z.enum(CHAT_MESSAGE_KINDS)
const requestId = z.string().trim().min(1).max(200)
export const personMessageInput = z.object({ text: z.string().trim().min(1).max(CHAT_PERSON_MESSAGE_MAX), kind: messageKind.optional(), request_id: requestId }).strict()
const note = z.string().trim().min(1).max(CHAT_DECISION_NOTE_MAX).optional()
export const resolutionDecisionInput = z.object({ resolution_id: id, note }).strict()
export const createChannelInput = z.object({ project_id: id, name: z.string().trim().min(1).max(CHAT_CHANNEL_NAME_MAX),
  description: z.string().trim().min(1).max(CHAT_CHANNEL_DESCRIPTION_MAX).optional(), leader_session_id: z.string().min(8).max(200).optional() }).strict()
export const proposeResolutionShape = { thread_id: id, text: z.string().trim().min(1).max(CHAT_RESOLUTION_TEXT_MAX),
  agreed: z.array(z.string().min(8).max(200)).max(20).default([]), request_id: requestId }

/** Declared JSON columns arrive parsed; computed json_object()/json columns of subqueries may arrive as text. */
const asJson = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value ?? null
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const fail = (status: number, code: string, message: string): never => { throw new MemoryError(status, message, false, code) }
const activeStates = ACTIVE_TEAM_STATES.map(state => `'${state}'`).join(",")

async function personSession(sql: Sql, channelId: string) {
  const sender = `hub-person:${channelId}`
  await sql.query(`INSERT OR IGNORE INTO chat_sessions(id,agent_id,key_hash,label,cli_kind,channel_id,state,event_at,closed_at)
    VALUES($1,$2,$3,'Persona',$4,$5,'offline',now(),now())`, [sender, PERSON_AGENT_ID, hash(randomUUID()), PERSON_CLI_KIND, channelId])
  return sender
}
async function hubSession(sql: Sql, channelId: string) {
  const sender = `hub-system:${channelId}`
  await sql.query(`INSERT OR IGNORE INTO chat_sessions(id,agent_id,key_hash,label,cli_kind,channel_id,state,event_at,closed_at)
    VALUES($1,'agenthub-system',$2,'Agent Hub','hub',$3,'offline',now(),now())`, [sender, hash(randomUUID()), channelId])
  return sender
}

/** Open agent sessions that follow a thread: its channel leader, its authors and the proposer of any resolution. */
async function threadAudience(sql: Sql, thread: Record<string, any>) {
  const rows = await sql.query(`SELECT DISTINCT s.id FROM chat_sessions s JOIN chat_channels c ON c.id=$2
    WHERE s.closed_at IS NULL AND s.removed_at IS NULL AND s.cli_kind NOT IN (${nonAgent}) AND s.nickname IS NOT NULL
    AND s.id IS NOT c.displaced_leader_id
    AND (s.id=c.leader_id OR s.id IN (SELECT author_id FROM chat_messages WHERE thread_id=$1) OR s.id IN (SELECT proposed_by FROM chat_thread_resolutions WHERE thread_id=$1))`,
  [thread.id, thread.channel_id])
  return rows.map(row => String(row.id))
}

async function postMessage(sql: Sql, thread: Record<string, any>, authorId: string, text: string, requestKey: string, kind: string | null = null) {
  const requestHash = hash(JSON.stringify({ text, kind }))
  const prior = (await sql.query("SELECT * FROM chat_messages WHERE author_id=$1 AND request_id=$2", [authorId, requestKey]))[0]
  if (prior) {
    if (prior.request_hash !== requestHash) fail(409, "request_conflict", "request_id ya usado con otro mensaje.")
    return { message: prior, notified: 0 }
  }
  const message = (await sql.query("INSERT INTO chat_messages(id,thread_id,author_id,text,request_id,request_hash,kind) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [randomUUID(), thread.id, authorId, text, requestKey, requestHash, kind]))[0]!
  const audience = await threadAudience(sql, thread)
  for (const recipient of audience) await sql.query("INSERT INTO chat_deliveries(message_id,recipient_id,response_required) VALUES($1,$2,0)", [message.id, recipient])
  await sql.query("UPDATE chat_threads SET updated_at=now(),archived_notice=0 WHERE id=$1", [thread.id])
  return { message, notified: audience.length }
}

async function requireThread(sql: Sql, threadId: string) {
  const thread = (await sql.query("SELECT * FROM chat_threads WHERE id=$1", [threadId]))[0]
  if (!thread) return fail(404, "thread_not_found", "Hilo inexistente.")
  const channel = (await sql.query("SELECT * FROM chat_channels WHERE id=$1", [thread.channel_id]))[0]!
  if (channel.deleted_at) fail(404, "thread_not_found", "El canal del hilo está en la papelera.")
  return { thread, channel }
}
const writable = (channel: Record<string, any>) => {
  if (channel.closed_at || (channel.kind === "virtual" && !channel.activated_at)) fail(409, "channel_unavailable", "El canal está cerrado o inactivo.")
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
    decision_note: row.decision_note ?? null, decision_entity_id: row.decision_entity_id ?? null }
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

/** MCP, agents only: the channel leader, or the master of the team the thread belongs to. Never decides anything. */
export async function proposeResolution(sql: Sql, who: Record<string, any>, input: { thread_id: string; text: string; agreed: string[]; request_id: string }) {
  const { thread, channel } = await requireThread(sql, input.thread_id)
  const prior = (await sql.query("SELECT * FROM chat_thread_resolutions WHERE proposed_by=$1 AND request_id=$2", [who.id, input.request_id]))[0]
  const agreed = [...new Set([who.id, ...input.agreed])].sort()
  if (prior) {
    check(prior.thread_id === thread.id && prior.text === input.text && JSON.stringify(asJson(prior.agreed_session_ids)) === JSON.stringify(agreed), "request_id ya usado con otra propuesta.", 409)
    return resolutionView(sql, prior)
  }
  writable(channel)
  check(thread.state === "open", "Este hilo está resuelto; reabrilo antes de proponer una resolución.", 409)
  const root = thread.team_root_thread_id ?? thread.id
  const master = (await sql.query(`SELECT p.id FROM chat_team_plans p JOIN chat_channels mc ON mc.id=p.master_channel_id
    WHERE p.root_thread_id=$1 AND p.created_by=$2 AND p.state IN (${activeStates}) AND mc.leader_id=$2 AND mc.closed_at IS NULL`, [root, who.id]))[0]
  const plan = (await sql.query("SELECT id FROM chat_team_plans WHERE root_thread_id=$1", [root]))[0]
  const leads = !plan && channel.leader_id === who.id && (await writeAssociation(sql, who.id, channel.id)) === "leader"
  check(master || leads, "Sólo el líder del canal (o el master del equipo del hilo) propone la resolución; los demás opinan en el hilo.", 403)
  const authors = new Set((await sql.query(`SELECT DISTINCT m.author_id FROM chat_messages m JOIN chat_sessions a ON a.id=m.author_id
    WHERE m.thread_id=$1 AND a.cli_kind NOT IN (${nonAgent})`, [thread.id])).map(row => String(row.author_id)))
  for (const session of agreed) check(session === who.id || authors.has(session), "Cada agente de acuerdo debe haber participado en el hilo.", 400)
  const participants = authors.has(who.id) ? authors.size : authors.size + 1
  const superseded = await sql.query("UPDATE chat_thread_resolutions SET state='superseded',decided_at=now() WHERE thread_id=$1 AND state='pending' RETURNING id", [thread.id])
  const row = (await sql.query(`INSERT INTO chat_thread_resolutions(id,thread_id,channel_id,proposed_by,request_id,text,agreed_session_ids,participant_count)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [randomUUID(), thread.id, channel.id, who.id, input.request_id, input.text, JSON.stringify(agreed), participants]))[0]!
  await sql.query("UPDATE chat_threads SET updated_at=now(),archived_notice=0 WHERE id=$1", [thread.id])
  await recordAuthorityEvent(sql, { kind: "resolution_proposed", channel_id: channel.id, project_id: await channelProjectId(sql, channel.id), actor_session_id: who.id,
    reason: "Resolución propuesta por agente", evidence: { thread_id: thread.id, resolution_id: row.id, agreed, participant_count: participants, superseded: superseded.map(item => item.id) } })
  return resolutionView(sql, row)
}

/** Authenticated person route only. */
export async function personMessage(sql: Sql, threadId: string, input: z.infer<typeof personMessageInput>) {
  const { thread, channel } = await requireThread(sql, threadId)
  writable(channel)
  const sender = await personSession(sql, channel.id)
  const prior = (await sql.query("SELECT id FROM chat_messages WHERE author_id=$1 AND request_id=$2", [sender, input.request_id]))[0]
  if (!prior && thread.state !== "open") fail(409, "thread_resolved", "El hilo está resuelto.")
  const { message, notified } = await postMessage(sql, thread, sender, input.text, input.request_id, input.kind ?? null)
  return { message: { id: message.id, thread_id: message.thread_id, text: message.text, kind: message.kind ?? null, author_source: "person" as const, created_at: message.created_at }, notified }
}

async function pendingFor(sql: Sql, threadId: string, resolutionId: string) {
  const { thread, channel } = await requireThread(sql, threadId)
  const resolution = (await sql.query("SELECT * FROM chat_thread_resolutions WHERE id=$1 AND thread_id=$2", [resolutionId, thread.id]))[0]
  if (!resolution) return fail(404, "resolution_not_pending", "La propuesta no pertenece a este hilo.")
  if (resolution.state === "superseded") fail(409, "resolution_changed", "Los agentes reemplazaron esta propuesta; actualizá la vista.")
  if (resolution.state !== "pending") fail(409, "resolution_not_pending", "Esta propuesta ya fue decidida.")
  return { thread, channel, resolution }
}

/** Authenticated person route only: records the project decision, resolves the thread and tells the agents. */
export async function approveResolution(sql: Sql, store: MemoryStore, threadId: string, input: z.infer<typeof resolutionDecisionInput>, userId: string) {
  const { thread, channel, resolution } = await pendingFor(sql, threadId, input.resolution_id)
  const projectId = await channelProjectId(sql, channel.id)
  if (!projectId) fail(409, "no_project", "El canal no pertenece a un proyecto; no hay dónde registrar la decisión.")
  const agreed = asJson(resolution.agreed_session_ids)
  const decision = await store.create({ kind: "fact", title: resolution.text.slice(0, 180), project_ids: [projectId],
    data: { text: resolution.text, category: "decision", review_state: "accepted", origin: "collaboration", occurred_at: new Date().toISOString(),
      thread_id: thread.id, channel_id: channel.id, resolution_id: resolution.id, agreed_session_ids: agreed, ...(input.note ? { note: input.note } : {}) } }, `user:${userId}`, sql)
  const updated = (await sql.query(`UPDATE chat_thread_resolutions SET state='approved',decided_at=now(),decided_by_user=$2,decision_note=$3,decision_entity_id=$4
    WHERE id=$1 AND state='pending' RETURNING *`, [resolution.id, userId, input.note ?? null, decision.id]))[0]
  check(updated, "La propuesta cambió durante la operación; actualizá la vista.", 409)
  const hub = await hubSession(sql, channel.id)
  const text = `Agent Hub: the person approved the proposed resolution of this thread and recorded it as project decision ${decision.id}. The thread is resolved.\nResolution: ${resolution.text}${input.note ? `\nPerson's note: ${input.note}` : ""}`
  const { notified } = await postMessage(sql, thread, hub, text, `resolution:${resolution.id}:approved`)
  // The person's decision closes the debate even if agents still owed each other replies.
  await sql.query(`UPDATE chat_deliveries SET cancelled_at=now(),error='Hilo resuelto por la persona' WHERE response_required=1 AND response_message_id IS NULL AND cancelled_at IS NULL
    AND message_id IN (SELECT id FROM chat_messages WHERE thread_id=$1)`, [thread.id])
  await sql.query("UPDATE chat_threads SET state='resolved',updated_at=now() WHERE id=$1", [thread.id])
  await recordAuthorityEvent(sql, { kind: "resolution_approved", channel_id: channel.id, project_id: projectId, actor_user_id: userId, target_session_id: resolution.proposed_by,
    reason: input.note ?? "Resolución aprobada por la persona", evidence: { thread_id: thread.id, resolution_id: resolution.id, decision_entity_id: decision.id, agreed } })
  return { resolution: (await resolutionView(sql, updated))!, decision: { id: decision.id, title: decision.title, project_id: projectId! }, thread: { id: thread.id, state: "resolved" as const }, notified }
}

/** Authenticated person route only: the proposal is set aside and the debate continues. */
export async function rerunResolution(sql: Sql, threadId: string, input: z.infer<typeof resolutionDecisionInput>, userId: string) {
  const { thread, channel, resolution } = await pendingFor(sql, threadId, input.resolution_id)
  writable(channel)
  const updated = (await sql.query(`UPDATE chat_thread_resolutions SET state='rerun',decided_at=now(),decided_by_user=$2,decision_note=$3 WHERE id=$1 AND state='pending' RETURNING *`,
    [resolution.id, userId, input.note ?? null]))[0]
  check(updated, "La propuesta cambió durante la operación; actualizá la vista.", 409)
  await sql.query("UPDATE chat_threads SET state='open',updated_at=now() WHERE id=$1", [thread.id])
  const hub = await hubSession(sql, channel.id)
  let { notified } = await postMessage(sql, thread, hub,
    `Agent Hub: the person did not approve the proposed resolution (${resolution.id}) and asked for another round of debate in this thread. Keep discussing; the leader may propose a new resolution.`,
    `resolution:${resolution.id}:rerun`)
  if (input.note) notified = Math.max(notified, (await postMessage(sql, thread, await personSession(sql, channel.id), input.note, `resolution:${resolution.id}:rerun-note`, "question")).notified)
  await recordAuthorityEvent(sql, { kind: "resolution_rerun", channel_id: channel.id, project_id: await channelProjectId(sql, channel.id), actor_user_id: userId,
    target_session_id: resolution.proposed_by, reason: input.note ?? "Otra ronda pedida por la persona", evidence: { thread_id: thread.id, resolution_id: resolution.id } })
  return { resolution: (await resolutionView(sql, updated))!, thread: { id: thread.id, state: "open" as const }, notified }
}

/**
 * Authenticated person route only: creating it in the UI is the person's explicit authorization. Its scope key never
 * matches a folder, so no session joins it by path; a designated leader keeps its other channels (multi-channel).
 */
export async function createProjectChannel(sql: Sql, input: z.infer<typeof createChannelInput>, userId: string) {
  check((await sql.query("SELECT 1 FROM entities WHERE id=$1 AND kind='project'", [input.project_id])).length, "Proyecto inexistente.", 404)
  if (input.leader_session_id) {
    const leader = (await sql.query("SELECT * FROM chat_sessions WHERE id=$1", [input.leader_session_id]))[0]
    if (!leader?.nickname || leader.closed_at || leader.removed_at || NON_AGENT_CLI_KINDS.includes(leader.cli_kind) || !leaseActive(leader)
      || await sessionProjectId(sql, leader.id) !== input.project_id)
      fail(409, "leader_unavailable", "El líder elegido debe ser un agente conectado del mismo proyecto.")
  }
  const channelId = randomUUID()
  const channel = (await sql.query(`INSERT INTO chat_channels(id,project_id,path,name,scope_key,kind,leader_id,leader_changed_at,activated_at,description)
    VALUES($1,$2,'',$3,$4,'virtual',$5,CASE WHEN $5 IS NULL THEN NULL ELSE now() END,now(),$6) RETURNING *`,
  [channelId, input.project_id, input.name, `ui:${channelId}`, input.leader_session_id ?? null, input.description ?? null]))[0]!
  await recordAuthorityEvent(sql, { kind: "channel_created", channel_id: channel.id, project_id: input.project_id, actor_user_id: userId, target_session_id: input.leader_session_id ?? null,
    reason: "Canal creado desde la UI", evidence: { name: input.name } })
  if (input.leader_session_id) {
    await recordAuthorityEvent(sql, { kind: "leadership_designated", channel_id: channel.id, project_id: input.project_id, actor_user_id: userId,
      target_session_id: input.leader_session_id, reason: "Líder designado al crear el canal desde la UI", evidence: { previous_leader_id: null } })
    const hub = await hubSession(sql, channel.id)
    await sql.query("INSERT INTO chat_status_notices(id,session_id,turn_id,cause,channel_id,recipient_id,text) VALUES($1,$2,$3,'channel_assigned',$4,$5,$6)",
      [randomUUID(), hub, `channel:${channel.id}`, channel.id, input.leader_session_id,
        `Agent Hub: the person created channel "${channel.name}" (${channel.id}) in your project and made you its leader. You keep your current channel; open threads there with memory_chat_send(channel_id=${channel.id}, title, ...).`])
  }
  return { channel: { id: channel.id, project_id: input.project_id, name: channel.name, description: channel.description ?? null, leader_id: channel.leader_id ?? null, created_at: channel.created_at } }
}

export const pendingDebatesQuery = z.object({ project_id: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }).strict()
export async function pendingDebates(sql: Sql, filter: z.infer<typeof pendingDebatesQuery>) {
  const base = `SELECT r.id AS resolution_id,r.thread_id,t.title AS thread_title,r.channel_id,c.name AS channel_name,
      COALESCE((SELECT master.project_id FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id JOIN chat_channels master ON master.id=p.master_channel_id
        WHERE m.channel_id=c.id ORDER BY p.created_at DESC LIMIT 1),c.project_id) AS project_id,
      r.text,json_array_length(r.agreed_session_ids) AS agreed_count,r.participant_count,s.label AS proposed_by_label,r.created_at,r.rowid AS position
    FROM chat_thread_resolutions r JOIN chat_threads t ON t.id=r.thread_id JOIN chat_channels c ON c.id=r.channel_id JOIN chat_sessions s ON s.id=r.proposed_by
    WHERE r.state='pending' AND c.deleted_at IS NULL`
  const query = `SELECT d.*,e.title AS project_title FROM (${base}) d LEFT JOIN entities e ON e.id=d.project_id WHERE ($1 IS NULL OR d.project_id=$1)`
  const total = Number((await sql.query(`SELECT count(*) AS n FROM (${query})`, [filter.project_id ?? null]))[0]!.n)
  const items = await sql.query(`SELECT * FROM (${query}) ORDER BY created_at DESC,position DESC LIMIT $2 OFFSET $3`, [filter.project_id ?? null, filter.limit, filter.offset])
  return { items: items.map(({ position: _position, ...item }) => ({ ...item, agreed_count: Number(item.agreed_count), participant_count: Number(item.participant_count) })),
    total, limit: filter.limit, offset: filter.offset }
}
