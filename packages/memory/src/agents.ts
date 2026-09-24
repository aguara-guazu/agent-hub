import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { check, id, parse } from './contracts.js'
import type { Sql } from './database.js'
import { requireEntity, type MemoryStore } from './store.js'

/** Identity the gateway attaches to every memory call (MCP `_meta`). Absent for the hub UI and for older gateways. */
export interface AgentContext { agent_id: string; cli_kind: string; client: string; session_id: string; cwd: string | null }
export const agentMetaSchema = z.object({ agent_id: z.string().min(1).max(200), cli_kind: z.string().max(60).default(''),
  client: z.string().max(200).default(''), session_id: z.string().min(8).max(200), cwd: z.string().max(4000).nullable().default(null) }).strip()
export const AGENT_META_KEY = 'agenthub/agent'

/** A working note without activity from its session for this long is shown as finished. */
export const NOTE_INACTIVITY_MINUTES = 20
const CLI_NAMES: Record<string, string> = { claude_code: 'Claude Code', codex_cli: 'Codex', gemini_cli: 'Gemini CLI', kiro: 'Kiro', claude_desktop: 'Claude Desktop', opencode: 'OpenCode' }

export function agentFromMeta(meta: unknown): AgentContext | undefined {
  const raw = meta && typeof meta === 'object' ? (meta as Record<string, unknown>)[AGENT_META_KEY] : undefined
  const parsed = agentMetaSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}
export function agentLabel(agent: AgentContext): string {
  return `${CLI_NAMES[agent.cli_kind] ?? (agent.client || agent.cli_kind || 'Agente')} · ${agent.session_id.replace(/^native:/, '').slice(0, 6)}`
}

const samePath = (a: string, b: string) => process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase()
function normalizePath(path: string) { return path.replace(/\\/g, '/').replace(/\/+$/, '') || '/' }

/** The project whose declared work folder is the longest prefix of `path`. */
export async function projectForPath(sql: Sql, path: string | null | undefined) {
  if (!path) return null
  const target = normalizePath(path)
  const projects = await sql.query("SELECT id,title,data FROM entities WHERE kind='project' AND jsonb_typeof(data->'folders')='array' AND jsonb_array_length(data->'folders')>0")
  let best: { project: Record<string, any>; folder: string } | null = null
  for (const project of projects) for (const raw of project.data.folders as string[]) {
    const folder = normalizePath(raw)
    const inside = samePath(target, folder) || samePath(target.slice(0, folder.length + 1), `${folder}/`)
    if (inside && (!best || folder.length > best.folder.length)) best = { project, folder }
  }
  return best ? { id: best.project.id as string, title: best.project.title as string, folder: best.folder } : null
}

/** Records the call's session. The project is resolved from the session's working folder when the session starts or moves. */
export async function touchSession(store: MemoryStore, agent: AgentContext) {
  // Folder assignments can change while a gateway session remains alive.
  const project = (await projectForPath(store.db, agent.cwd))?.id ?? null
  await store.db.query(`INSERT INTO agent_sessions(id,agent_id,agent_label,cli_kind,cwd,project_id) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(id) DO UPDATE SET last_seen_at=now(),ended_at=NULL,cwd=excluded.cwd,project_id=excluded.project_id,agent_label=excluded.agent_label`,
  [agent.session_id, agent.agent_id, agentLabel(agent), agent.cli_kind, agent.cwd, project])
  return project as string | null
}

/** Working notes whose session ended or went quiet are closed; the reason keeps the difference visible. */
export async function sweepNotes(sql: Sql) {
  await sql.query(`UPDATE agent_notes n SET state='done',finish_reason=CASE WHEN s.ended_at IS NOT NULL THEN 'session_end' ELSE 'inactive' END,finished_at=now()
    FROM agent_notes n2 LEFT JOIN agent_sessions s ON s.id=n2.session_id
    WHERE n.id=n2.id AND n.state='working' AND n.updated_at<now()-make_interval(mins=>$1)
      AND (s.id IS NULL OR s.ended_at IS NOT NULL OR s.last_seen_at<now()-make_interval(mins=>$1))`, [NOTE_INACTIVITY_MINUTES])
}

export const writeNoteInput = z.object({ id: id.optional(), text: z.string().trim().min(1).max(600),
  state: z.enum(['working', 'done', 'blocked']).optional(), project_id: id.nullable().optional(), task_id: id.nullable().optional() }).strict()
export const listNotesInput = z.object({ project_id: id.optional(), scope: z.enum(['project', 'unassigned', 'all']).default('all'),
  include_finished: z.boolean().default(true), limit: z.number().int().min(1).max(200).default(40), offset: z.number().int().min(0).default(0) }).strict()
export const finishNotesInput = z.object({ state: z.enum(['done', 'blocked']).default('done'), summary: z.string().trim().min(1).max(600).optional(),
  reason: z.enum(['explicit', 'session_end', 'turn_end']).default('explicit'), before: z.iso.datetime().optional() }).strict()

function author(agent: AgentContext | undefined, actor: string) {
  return agent ? { agent_id: agent.agent_id, agent_label: agentLabel(agent), cli_kind: agent.cli_kind, session_id: agent.session_id }
    : { agent_id: actor, agent_label: actor === 'user' ? 'Persona' : actor, cli_kind: '', session_id: null }
}

/**
 * A new working note from a session supersedes that session's previous working note in the same project, so the board shows one line per agent run.
 * Updating a note is limited to its own session; the hub UI (no agent context) can correct any note.
 */
export async function writeNote(store: MemoryStore, raw: unknown, actor: string, agent?: AgentContext) {
  const input = parse(writeNoteInput, raw)
  const sessionProject = agent ? await touchSession(store, agent) : null
  const projectId = input.project_id === undefined ? sessionProject : input.project_id
  if (projectId) await requireEntity(store.db, projectId, 'project')
  if (input.task_id) check((await store.db.query('SELECT 1 FROM tasks WHERE id=$1', [input.task_id])).length, 'Tarea inexistente', 404)
  const who = author(agent, actor)
  return store.db.transaction(async sql => {
    if (input.id) {
      const note = (await sql.query('SELECT * FROM agent_notes WHERE id=$1 FOR UPDATE', [input.id]))[0]
      check(note, 'Nota inexistente', 404)
      check(!agent || note.session_id === agent.session_id, 'Sólo la sesión que escribió la nota puede editarla; deja una nota nueva', 403)
      const state = input.state ?? note.state
      return (await sql.query(`UPDATE agent_notes SET text=$2,state=$3,project_id=$4,task_id=$5,updated_at=now(),
        finished_at=CASE WHEN $3='working' THEN NULL ELSE COALESCE(finished_at,now()) END,finish_reason=CASE WHEN $3='working' THEN NULL ELSE COALESCE(finish_reason,'explicit') END
        WHERE id=$1 RETURNING *`, [input.id, input.text, state,
        input.project_id === undefined ? note.project_id : input.project_id, input.task_id === undefined ? note.task_id : input.task_id]))[0]
    }
    const state = input.state ?? 'working'
    if (state === 'working' && who.session_id) await sql.query(`UPDATE agent_notes SET state='done',finish_reason='superseded',finished_at=now(),updated_at=now()
      WHERE session_id=$1 AND state='working' AND project_id IS NOT DISTINCT FROM $2`, [who.session_id, projectId])
    return (await sql.query(`INSERT INTO agent_notes(id,session_id,agent_id,agent_label,cli_kind,project_id,task_id,text,state,finish_reason,finished_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $9='working' THEN NULL ELSE 'explicit' END,CASE WHEN $9='working' THEN NULL ELSE now() END) RETURNING *`,
    [randomUUID(), who.session_id, who.agent_id, who.agent_label, who.cli_kind, projectId, input.task_id ?? null, input.text, state]))[0]
  })
}

export async function finishNotes(store: MemoryStore, raw: unknown, agent?: AgentContext) {
  const input = parse(finishNotesInput, raw)
  check(agent, 'Cerrar notas requiere la sesión de un agente; desde el hub edita la nota', 409)
  if (input.reason === 'session_end') await store.db.query('UPDATE agent_sessions SET ended_at=now() WHERE id=$1 AND ($2::timestamptz IS NULL OR last_seen_at<=$2)', [agent.session_id, input.before ?? null])
  else if (input.reason === 'explicit') await touchSession(store, agent)
  return store.db.transaction(async sql => {
    const closed = await sql.query(`UPDATE agent_notes SET state=$2,finish_reason=$3,finished_at=now(),updated_at=now(),text=COALESCE($4,text)
      WHERE session_id=$1 AND state='working' AND ($5::timestamptz IS NULL OR updated_at<=$5) RETURNING id,project_id`, [agent.session_id, input.state, input.reason, input.summary ?? null, input.before ?? null])
    return { closed: closed.length, notes: closed }
  })
}

export async function listNotes(store: MemoryStore, raw: unknown) {
  const input = parse(listNotesInput, raw)
  if (input.project_id) await requireEntity(store.db, input.project_id, 'project')
  await sweepNotes(store.db)
  const params = [input.project_id ?? null, input.scope, input.include_finished]
  const where = `(($1::uuid IS NOT NULL AND n.project_id=$1) OR ($1::uuid IS NULL AND ($2='all' OR ($2='unassigned' AND n.project_id IS NULL))))
    AND ($3::boolean OR n.state<>'done')`
  const items = await store.db.query(`SELECT n.*,p.title AS project_title,t.title AS task_title,t.external_key AS task_key,
    s.last_seen_at,s.ended_at,(n.state='working') AS active FROM agent_notes n LEFT JOIN entities p ON p.id=n.project_id
    LEFT JOIN tasks t ON t.id=n.task_id LEFT JOIN agent_sessions s ON s.id=n.session_id WHERE ${where}
    ORDER BY (n.state='working') DESC,n.updated_at DESC,n.id LIMIT $4 OFFSET $5`, [...params, input.limit, input.offset])
  const total = (await store.db.query(`SELECT count(*)::int AS total FROM agent_notes n WHERE ${where}`, params))[0]!.total
  return { items, total, limit: input.limit, offset: input.offset, inactivity_minutes: NOTE_INACTIVITY_MINUTES }
}

export const contextInput = z.object({ path: z.string().trim().min(1).max(4000).optional() }).strict()

/** First call of a work session: which project this folder belongs to, what is open there and what other agents are doing now. */
export async function workContext(store: MemoryStore, raw: unknown, agent?: AgentContext) {
  const input = parse(contextInput, raw)
  if (agent) await touchSession(store, agent)
  const path = input.path ?? agent?.cwd ?? null
  const match = await projectForPath(store.db, path)
  await sweepNotes(store.db)
  const project = match ? await requireEntity(store.db, match.id, 'project') : null
  const scope = [match?.id ?? null]
  const [tasks, working, recent, candidates] = await Promise.all([
    store.db.query(`SELECT id,kind,title,status,external_key,external_status,assignee,updated_at FROM tasks WHERE project_id=$1 AND status IN ('todo','in_progress','blocked')
      ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END,updated_at DESC LIMIT 15`, scope),
    store.db.query(`SELECT id,agent_label,cli_kind,text,task_id,updated_at,session_id FROM agent_notes WHERE state='working' AND project_id IS NOT DISTINCT FROM $1 ORDER BY updated_at DESC LIMIT 20`, scope),
    store.db.query(`SELECT id,agent_label,text,state,finish_reason,updated_at FROM agent_notes WHERE state<>'working' AND project_id IS NOT DISTINCT FROM $1 ORDER BY updated_at DESC LIMIT 10`, scope),
    match ? Promise.resolve([]) : store.db.query("SELECT id,title,data->'folders' AS folders,data->>'jira_project_key' AS jira_project_key FROM entities WHERE kind='project' ORDER BY updated_at DESC LIMIT 30"),
  ])
  return {
    agent: agent ? { ...agent, label: agentLabel(agent) } : null, path,
    project: project ? { id: project.id, title: project.title, folder: match!.folder, status: project.data.status ?? null, description: project.data.description ?? null,
      jira_project_key: project.data.jira_project_key ?? null, jira_site_url: project.data.jira_site_url ?? null } : null,
    open_tasks: tasks, working_notes: working.filter(n => n.session_id !== agent?.session_id), own_working_notes: working.filter(n => agent && n.session_id === agent.session_id),
    recent_notes: recent, projects: candidates,
    guidance: project
      ? `Esta carpeta pertenece a «${project.title}». Busca primero con project_id=${project.id} y amplía a toda la memoria sólo si no alcanza. Antes de trabajar, lee working_notes y deja tu nota con memory_write_note; al terminar, ciérrala con memory_finish_notes.`
      : 'Esta carpeta no está asociada a ningún proyecto. Si corresponde a uno de projects, pide a la persona que agregue la carpeta al proyecto (o hazlo con memory_update_entity en data.folders) y busca con su project_id.',
  }
}
