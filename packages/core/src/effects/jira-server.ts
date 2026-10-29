import type { Store } from '../store.js'
import { JIRA_GET_ISSUE_TOOL, JIRA_USER_INFO_TOOL } from './jira.js'

/** Setting del dueño con el id (del catálogo, no el slug) del servidor Atlassian donde se escribe en Jira. */
export const JIRA_SERVER_SETTING = 'jira.server_id'

/**
 * Servidor de Jira fijado por el dueño para las escrituras, o `undefined` si no hay ninguno utilizable. Se valida contra el catálogo en cada lectura:
 * un id que ya no existe o que pertenece a otro dueño no se usa, de modo que la escritura falla cerrada en lugar de elegir un servidor.
 */
export function readJiraServerId(store: Store, ownerId: string): string | undefined {
  const id = store.setting(JIRA_SERVER_SETTING)?.trim()
  if (!id) return undefined
  const server = store.server(id)
  return server && server.user_id === ownerId ? server.id : undefined
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
 * Fija o borra (`null`) el servidor de Jira del dueño. Devuelve el motivo del rechazo, o `null` si guardó; ante un rechazo no toca el setting.
 * Borrar deja las escrituras cerradas porque `readJiraServerId` vuelve a `undefined`.
 */
export function saveJiraServerId(store: Store, ownerId: string, serverId: string | null): 'unknown_server' | 'not_usable' | null {
  if (serverId === null) { store.deleteSetting(JIRA_SERVER_SETTING); return null }
  const server = store.server(serverId)
  if (!server || server.user_id !== ownerId) return 'unknown_server'
  if (!isUsableJiraServer(store, server.id)) return 'not_usable'
  store.setSetting(JIRA_SERVER_SETTING, server.id)
  return null
}
