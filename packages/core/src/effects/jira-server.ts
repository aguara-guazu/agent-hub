import type { Store } from '../store.js'
import { JIRA_GET_ISSUE_TOOL, JIRA_USER_INFO_TOOL } from './jira.js'

/** Setting del dueño con el id (del catálogo, no el slug) del servidor Atlassian donde se escribe en Jira. */
export const JIRA_SERVER_SETTING = 'jira.server_id'

/** Valor guardado cuando el dueño eligió «Ninguno»: distingue esa decisión de no haber elegido todavía. */
export const JIRA_SERVER_NONE = 'none'
/** Conector Atlassian del catálogo que rige mientras el dueño no eligió servidor. */
export const DEFAULT_JIRA_SERVER_SLUG = 'atlassian-rovo'

/**
 * Servidor de Jira para las escrituras, o `undefined` si no hay ninguno utilizable. Se valida contra el catálogo en cada lectura.
 * Un id elegido que ya no existe o que pertenece a otro dueño no se usa, de modo que la escritura falla cerrada en lugar de elegir otro servidor.
 * Sin elección rige el conector `atlassian-rovo` del dueño si es utilizable; «Ninguno» elegido explícitamente no vuelve a ese valor.
 */
export function readJiraServerId(store: Store, ownerId: string): string | undefined {
  const id = store.setting(JIRA_SERVER_SETTING)?.trim()
  if (id === JIRA_SERVER_NONE) return undefined
  if (id) {
    const server = store.server(id)
    return server && server.user_id === ownerId ? server.id : undefined
  }
  const fallback = store.serversOfUser(ownerId).find(server => server.slug === DEFAULT_JIRA_SERVER_SLUG)
  return fallback && isUsableJiraServer(store, fallback.id) ? fallback.id : undefined
}

/**
 * Servidor que reciben los adaptadores de Jira del core: el de `readJiraServerId` o `JIRA_SERVER_NONE`, que nunca es candidato del ejecutor.
 * Con `undefined` el ejecutor tomaría el único servidor que publique las herramientas; el centinela rechaza la intención con `tool_off`.
 */
export function jiraWriteServerId(store: Store, ownerId: string): string {
  return readJiraServerId(store, ownerId) ?? JIRA_SERVER_NONE
}

export interface JiraServerOption {
  id: string
  name: string
  /** El catálogo publica, sin cuarentena, las herramientas con las que se verifica la cuenta y el asignado antes de escribir. */
  usable: boolean
}

export interface JiraServerSelection {
  selected: string | null
  servers: JiraServerOption[]
}

/** Un servidor sirve para escribir en Jira solo si su catálogo trae `atlassianUserInfo` y `getJiraIssue` sin cuarentena; las reglas de exposición se evalúan aparte en cada llamada. */
function isUsableJiraServer(store: Store, serverId: string): boolean {
  const names = new Set(store.toolsOfServer(serverId).filter(tool => !tool.quarantined).map(tool => tool.name.toLowerCase()))
  return [JIRA_USER_INFO_TOOL, JIRA_GET_ISSUE_TOOL].every(name => names.has(name.toLowerCase()))
}

/** Servidores del dueño con su aptitud y el seleccionado vigente; el seleccionado se resuelve con la misma validación de dueño que usa la escritura. */
export function readJiraServerSelection(store: Store, ownerId: string): JiraServerSelection {
  return {
    selected: readJiraServerId(store, ownerId) ?? null,
    servers: store.serversOfUser(ownerId).map(server => ({ id: server.id, name: server.display_name, usable: isUsableJiraServer(store, server.id) })),
  }
}

/**
 * Fija el servidor de Jira del dueño, o «Ninguno» con `null`. Devuelve el motivo del rechazo, o `null` si guardó; ante un rechazo no toca el setting.
 * «Ninguno» deja las escrituras cerradas aunque exista el conector por defecto.
 */
export function saveJiraServerId(store: Store, ownerId: string, serverId: string | null): 'unknown_server' | 'not_usable' | null {
  if (serverId === null) { store.setSetting(JIRA_SERVER_SETTING, JIRA_SERVER_NONE); return null }
  const server = store.server(serverId)
  if (!server || server.user_id !== ownerId) return 'unknown_server'
  if (!isUsableJiraServer(store, server.id)) return 'not_usable'
  store.setSetting(JIRA_SERVER_SETTING, server.id)
  return null
}
