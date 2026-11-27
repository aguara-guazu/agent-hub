import { ConnectionPool, UpstreamSpec, resultText, type OAuthStore } from '@agenthub/gateway'
import { MemoryError, type NotionRead } from '@agenthub/memory'
import { moduleEnabled } from '../../modules/settings.js'
import { contractTrackingModules } from '@agenthub/shared/modules'
import type { Store } from '../../store.js'

/** Owner-initiated contract tracking only needs two reads from the connected Notion server. */
export function notionReader(store: Store, ownerId: string, pool: ConnectionPool, oauth: OAuthStore): NotionRead {
  return async (action, args, signal) => {
    signal.throwIfAborted()
    if (!contractTrackingModules.every((id) => moduleEnabled(store, id)))
      throw new MemoryError(409, 'La lectura de contratos de Notion está pausada')
    const server = store.serverBySlug(ownerId, 'notion')
    const name = action === 'fetch' ? 'notion-fetch' : 'notion-query-data-sources'
    if (
      !server ||
      store.findRule(ownerId, null, 'mcp_server', server.id)?.state === 'off' ||
      (server.auth === 'oauth' && !oauth.hasTokens(server.id))
    )
      throw new MemoryError(409, 'Conectá la cuenta de Notion en Servidores MCP para verificar los contratos')
    const tool = store.toolsOfServer(server.id).find((t) => t.name.replaceAll('_', '-') === name)
    if (!tool || tool.quarantined || store.findRule(ownerId, null, 'mcp_tool', tool.id)?.state === 'off')
      throw new MemoryError(403, 'Habilitá la lectura ' + name + ' del servidor Notion')
    const result = await pool.callTool('memory-ui:' + ownerId, new UpstreamSpec(server), tool.name, args)
    signal.throwIfAborted()
    if (result.is_error)
      throw new MemoryError(502, 'Notion no pudo verificar los contratos. Revisá el acceso a la base y sus relaciones.')
    const data = result.structured_content
    if (data && ('results' in data || 'text' in data)) return data
    try {
      return JSON.parse(resultText(result))
    } catch {
      throw new MemoryError(502, 'Notion devolvió una respuesta que no se pudo leer')
    }
  }
}
