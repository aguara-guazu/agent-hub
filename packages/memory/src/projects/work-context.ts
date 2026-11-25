import { z } from 'zod'
import { parse } from '../contracts.js'
import { requireEntity, type MemoryStore } from '../store.js'
import { agentLabel, projectForAgent, projectForPath, sharedProject, sharedProjectsWithoutFolder, sweepNotes, touchSession, type AgentContext, type AgentProject } from '../agents.js'
import { localIso, systemTimeZone } from '../schedules/schedule-time.js'
import { maintenanceStatus } from './memory-maintenance.js'

export interface ContextServices {
  scheduleContext(projectId?: string): Promise<{ scheduler?: unknown }>
  mediaCapabilities(): Promise<{ local_media?: unknown; binary_search_with_enabled_modules?: string }>
}

export const contextInput = z.object({ path: z.string().trim().min(1).max(4000).optional() }).strict()

/** First call of a work session: which project this folder belongs to, what is open there and what other agents are doing now. */
export async function workContext(store: MemoryStore, raw: unknown, extras: ContextServices, agent?: AgentContext) {
  const input = parse(contextInput, raw)
  if (agent) await touchSession(store, agent)
  const path = input.path ?? agent?.cwd ?? null
  const byPath = input.path ? await projectForPath(store.db, input.path) : null
  const match: AgentProject | null = input.path ? (byPath ? { ...byPath, source: "folder", shared: await sharedProject(store.db, byPath.id) } : null) : agent ? await projectForAgent(store.db, agent) : null
  await sweepNotes(store.db)
  const project = match ? await requireEntity(store.db, match.id, 'project') : null
  const scope = [match?.id ?? null]
  const [tasks, working, recent, candidates, sharedWithoutFolder] = await Promise.all([
    store.db.query(`SELECT id,kind,title,status,external_key,external_status,assignee,updated_at FROM tasks WHERE project_id=$1 AND status IN ('todo','in_progress','blocked')
      ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END,updated_at DESC LIMIT 15`, scope),
    store.db.query(`SELECT id,agent_label,cli_kind,text,task_id,updated_at,session_id FROM agent_notes WHERE state='working' AND project_id IS $1 ORDER BY updated_at DESC LIMIT 20`, scope),
    store.db.query(`SELECT id,agent_label,text,state,finish_reason,updated_at FROM agent_notes WHERE state<>'working' AND project_id IS $1 ORDER BY updated_at DESC LIMIT 10`, scope),
    match ? Promise.resolve([]) : store.db.query(`SELECT e.id,e.title,e.data->'folders' AS "folders:json",e.data->>'jira_project_key' AS jira_project_key,
      EXISTS(SELECT 1 FROM shared_projects shared WHERE shared.id=e.id) AS "shared:bool"
      FROM entities e WHERE e.kind='project' AND e.data->>'merged_into' IS NULL ORDER BY e.updated_at DESC LIMIT 30`),
    match ? Promise.resolve([]) : sharedProjectsWithoutFolder(store.db),
  ])
  const memories = await store.db.query(`SELECT id,title,substr(data->>'text',1,1200) AS text,data->>'memory_category' AS category,
    data->>'memory_confidence' AS confidence,data->>'memory_expires_at' AS expires_at,
    data->>'memory_pinned' AS pinned,updated_at FROM entities WHERE data->>'agent_memory' IN (1,'true')
      AND COALESCE(data->>'memory_state','active')='active' AND (data->>'memory_project_id' IS NULL OR data->>'memory_project_id' IS $1)
      ORDER BY (data->>'memory_pinned') IN (1,'true') DESC,CAST(data->>'memory_importance' AS INTEGER) DESC,updated_at DESC LIMIT 8`, scope)
  const maintenance = await maintenanceStatus(store, match?.id)
  const [scheduler, media] = await Promise.all([extras.scheduleContext(match?.id), extras.mediaCapabilities()])
  const zone = systemTimeZone(), nowLocal = localIso(Date.now(), zone)
  return {
    ...scheduler,
    memories, maintenance: { due: maintenance.due, last_run: maintenance.last?.finished_at ?? null, active: maintenance.active ? { id: maintenance.active.id, state: maintenance.active.state } : null },
    memory_capabilities: { primary_memory: true, remember: 'memory_remember', files: 'memory_import_file', retrieve_file: 'memory_get_file', tidy: 'memory_tidy_memory',
      formats: ['text','images','screenshots','audio','video','PDF','other files'], max_file_mb: 25, binary_search: 'title, description and annotations', ...media },
    agent: agent ? { ...agent, label: agentLabel(agent) } : null, path,
    person_time: { timezone: zone, utc_offset: nowLocal.slice(-6), now_local: nowLocal },
    project: project ? { id: project.id, title: project.title, folder: match!.folder, source: match!.source, shared: match!.shared,
      status: project.data.status ?? null, description: project.data.description ?? null,
      jira_project_key: project.data.jira_project_key ?? null, jira_site_url: project.data.jira_site_url ?? null } : null,
    open_tasks: tasks, working_notes: working.filter(n => n.session_id !== agent?.session_id), own_working_notes: working.filter(n => agent && n.session_id === agent.session_id),
    recent_notes: recent, projects: candidates,
    ...(sharedWithoutFolder.length ? { shared_without_folder: sharedWithoutFolder } : {}),
    guidance: project
      ? `La sesión trabaja en el proyecto ${match!.shared ? "compartido " : ""}«${project.title}» (${project.id}) por ${match!.source === "folder" ? "su carpeta local" : "su canal o equipo"}. Usa ese project_id y no crees otro proyecto para este trabajo.`
      : sharedWithoutFolder.length
        ? `Hay proyectos compartidos sin carpeta local: ${sharedWithoutFolder.map(item => `«${item.title}» (${item.id})`).join(", ")}. Asocia esta carpeta a uno de ellos; no crees un proyecto nuevo para reemplazarlo.`
        : 'Folder not linked to any project. If it matches one in projects, ask the person to add it there (or do it via memory_update_entity data.folders), then search with its project_id.',
  }
}
