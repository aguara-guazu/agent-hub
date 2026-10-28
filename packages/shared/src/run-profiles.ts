/**
 * Perfiles de run del scheduler.
 *
 * Un perfil es una identidad de política con capacidad fija: su cota se aplica DESPUÉS de las reglas on/off del dueño
 * y de los clientes, de modo que una regla `on` nunca devuelve una herramienta que el perfil no tiene. Todo lo que no
 * figura en la lista se deniega, incluidas las herramientas nuevas que un server publique más adelante.
 *
 * - `hub_run_action`: miembro de flota de un plan derivado. Solo lee la memoria acotada y reporta por el canal tipado del run.
 * - `hub_effects`: identidad de servicio del ejecutor del core. Nunca se entrega a un modelo ni a un proceso externo.
 *
 * Los `cli_kind` son sintéticos: `agent_instances` es UNIQUE(machine_id, cli_kind), así que cada perfil ocupa una fila propia.
 */

export const RUN_PROFILE_CLI_KINDS = ['hub_run_action', 'hub_effects'] as const
export type RunProfileKind = typeof RUN_PROFILE_CLI_KINDS[number]
export const RUN_PROFILE_VERSION = 1

export function isRunProfileCliKind(kind: string): kind is RunProfileKind {
  return (RUN_PROFILE_CLI_KINDS as readonly string[]).includes(kind)
}

export function isRunProfileAgent(agent: { cli_kind: string }): boolean {
  return isRunProfileCliKind(agent.cli_kind)
}

/** Lecturas de memoria acotadas. Sin escritura, sin chat/team y sin ninguna schedule_*. `run_report` es el canal tipado de reporte del run. */
const ACTION_MEMORY_TOOLS: ReadonlySet<string> = new Set([
  'context', 'search', 'get_entity', 'list_entities', 'timeline', 'get_evidence', 'list_records', 'list_tasks', 'get_task', 'task_stats', 'list_notes', 'transcript', 'health',
  'run_report',
])

/** Lecturas y escrituras exactas que el ejecutor puede invocar sobre las integraciones del dueño (Jira y Slack). Nombres en minúsculas. */
const EFFECT_TOOLS: ReadonlySet<string> = new Set([
  'atlassianuserinfo', 'getaccessibleatlassianresources', 'getjiraissue', 'searchjiraissuesusingjql', 'gettransitionsforjiraissue',
  'addworklogtojiraissue', 'transitionjiraissue', 'addcommenttojiraissue',
  'jira_get_issue', 'jira_get_transitions', 'jira_add_worklog', 'jira_transition_issue', 'jira_add_comment',
  'slack_send_message', 'slack_read_user_profile', 'slack_read_channel', 'slack_read_thread', 'slack_search_users', 'auth_test',
])

export interface ProfileToolRef {
  /** El server es el de memoria integrado en el hub. */
  memory: boolean
  /** Nombre de la herramienta tal como la publica su server, sin el prefijo expuesto. */
  tool: string
}

/** Decide si el perfil tiene la herramienta. Por defecto deniega. */
export function profileAllowsTool(kind: RunProfileKind, ref: ProfileToolRef): boolean {
  const name = ref.tool.toLowerCase()
  if (kind === 'hub_run_action') return ref.memory && ACTION_MEMORY_TOOLS.has(ref.tool)
  return !ref.memory && EFFECT_TOOLS.has(name)
}

export const RUN_PROFILE_DENIAL = 'La herramienta no forma parte de la capacidad fija de este perfil de run'
