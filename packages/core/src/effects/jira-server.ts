import type { Store } from '../store.js'

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
