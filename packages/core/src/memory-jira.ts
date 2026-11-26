import { moduleEnabled } from './modules/settings.js'
import { ConnectionPool, UpstreamSpec, resultText, type CallResult, type OAuthStore } from '@agenthub/gateway'
import { MemoryError, type JiraTaskReader } from '@agenthub/memory'
import type { Store } from './store.js'
import { computeSnapshot } from './policy/resolver.js'

const SEARCH = 'searchJiraIssuesUsingJql'
const RESOURCES = 'getAccessibleAtlassianResources'
const fields = ['summary', 'description', 'status', 'issuetype', 'priority', 'assignee', 'duedate', 'updated', 'project', 'issuelinks']

function searchJql(request: Parameters<JiraTaskReader>[0]) {
  const filters: string[] = []
  if (request.key) {
    if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(request.key)) throw new MemoryError(422, 'Clave de proyecto Jira no válida')
    filters.push(`project = "${request.key}"`)
  }
  if (request.issueKeys?.length) {
    if (request.issueKeys.length > 30 || !request.issueKeys.every(key => /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/.test(key)))
      throw new MemoryError(422, 'Claves de Jira no válidas')
    filters.push('key IN (' + request.issueKeys.map(key => '"' + key + '"').join(', ') + ')')
  }
  if (request.company) {
    // Use a Lucene phrase inside a JQL string. Only words from the company name enter either syntax.
    const phrase = request.company.match(/[\p{L}\p{N}]+/gu)?.join(' ')
    if (!phrase || phrase.length > 160) throw new MemoryError(422, 'Nombre de empresa no válido para buscar en Jira')
    filters.push('text ~ ' + JSON.stringify('"' + phrase + '"'))
  }
  if (!filters.length) throw new MemoryError(422, 'Indicá el proyecto, la empresa o el ticket de Jira')
  if (request.updatedMinutes) {
    if (!Number.isFinite(request.updatedMinutes)) throw new MemoryError(422, 'Intervalo de Jira no válido')
    filters.push(`updated >= -${Math.max(1, Math.ceil(request.updatedMinutes))}m`)
  }
  return filters.join(' AND ') + ' ORDER BY key ASC'
}

function value(result: CallResult): any {
  if (result.is_error) {
    const message = resultText(result)
    let detail = result.structured_content
    if (!detail) { try { detail = JSON.parse(message) } catch { /* Some servers return the error as plain text. */ } }
    const status = Number(detail?.statusCode ?? detail?.status)
    if (status === 401 || status === 403 || /\b(?:forbidden|unauthorized|HTTP\s+40[13])\b/i.test(message))
      throw new MemoryError(403, 'La cuenta conectada por MCP no tiene permisos para esta consulta en Jira.')
    throw new MemoryError(502, 'Jira no pudo completar la consulta. Revisa la conexión de Atlassian en MCP servers y vuelve a intentar.')
  }
  if (result.structured_content) return result.structured_content
  try { return JSON.parse(resultText(result)) } catch { throw new MemoryError(502, 'Jira devolvió una respuesta no válida para sincronizar tareas') }
}
function origin(raw: unknown): string | null {
  try { const url = new URL(String(raw)); return url.protocol === 'https:' && url.hostname.endsWith('.atlassian.net') ? url.origin : null } catch { return null }
}

/** Reuses the owner's connected Rovo MCP. UI requests use user policy; agent calls retain that agent's policy. */
export function createJiraTaskReader(store: Store, ownerId: string, pool: ConnectionPool, oauth: OAuthStore): JiraTaskReader {
  return async (request, onPage) => {
    const jql = searchJql(request)
    const catalog = () => {
      if (!moduleEnabled(store, 'mcp') || !moduleEnabled(store, 'connections')) throw new MemoryError(409, 'La conexión MCP está desactivada en Ajustes', false, 'module_disabled')
      if (request.agentId) {
        const agent = store.agent(request.agentId)
        if (!agent || store.machine(agent.machine_id)?.user_id !== ownerId) throw new MemoryError(403, 'La sesión no pertenece al dueño de esta memoria')
        return computeSnapshot(store, agent.id).servers
      }
      return store.serversOfUser(ownerId).filter(server => store.findRule(ownerId, null, 'mcp_server', server.id)?.state !== 'off')
        .map(server => ({ ...server, tools: store.toolsOfServer(server.id).filter(tool => !tool.quarantined && store.findRule(ownerId, null, 'mcp_tool', tool.id)?.state !== 'off') }))
    }
    const has = (server: { tools: { name: string }[] }, name: string) => server.tools.some(tool => tool.name === name)
    const servers = catalog().filter(server => has(server, SEARCH) && has(server, RESOURCES)
      && (server.auth !== 'oauth' || oauth.hasTokens(server.id)))
    if (!servers.length) throw new MemoryError(409, 'Conecta Atlassian Rovo en MCP servers y habilita la consulta de issues y sitios, o configura un conector Jira con token en Fuentes y ajustes.')
    const choices: { serverId: string; cloud: string; site: string }[] = []
    let unavailable = false, denied = false
    const call = async (serverId: string, name: string, args: Record<string, unknown>) => {
      request.signal?.throwIfAborted()
      // Re-evaluate before every page: OFF or quarantine must take effect during a long sync too.
      const server = catalog().find(server => server.id === serverId && has(server, name))
      if (!server) throw new MemoryError(403, 'La herramienta de Jira fue deshabilitada durante la sincronización')
      try {
        return value(await pool.callTool(request.agentId ?? `memory-ui:${ownerId}`, new UpstreamSpec(server), name, args))
      } catch (error) {
        if (error instanceof MemoryError) throw error
        throw new MemoryError(502, 'No se pudo consultar Jira. Revisa la conexión de Atlassian en MCP servers y vuelve a intentar.')
      }
    }
    for (const server of servers) {
      let resources: unknown
      try { resources = await call(server.id, RESOURCES, {}) } catch (error) {
        request.signal?.throwIfAborted()
        if (error instanceof MemoryError && error.statusCode === 403) denied = true
        else unavailable = true
        continue
      }
      if (!Array.isArray(resources)) { unavailable = true; continue }
      for (const resource of resources) {
        const row = resource as Record<string, unknown>, site = origin(row['url'])
        if (!site || typeof row['id'] !== 'string' || (request.site && site !== origin(request.site))) continue
        if (Array.isArray(row['scopes']) && !row['scopes'].some(scope => typeof scope === 'string' && scope.includes('jira'))) continue
        if (!choices.some(choice => choice.site === site)) choices.push({ serverId: server.id, cloud: row['id'], site })
      }
    }
    if (!choices.length && denied && !unavailable) throw new MemoryError(403, 'La cuenta conectada por MCP no tiene permisos para consultar los sitios de Jira.')
    if (!choices.length) throw new MemoryError(unavailable ? 502 : 409, unavailable
      ? 'No se pudo consultar la cuenta de Atlassian. Revisa su conexión en MCP servers y vuelve a sincronizar.'
      : 'La cuenta de Atlassian conectada no tiene acceso al sitio Jira del proyecto. Revisa el sitio y la cuenta en MCP servers.')
    if (choices.length !== 1) throw new MemoryError(409, 'Hay varios sitios Jira disponibles. Indica el sitio del proyecto antes de sincronizar.')
    const chosen = choices[0]!, seen = new Set<string>()
    let next: string | undefined, count = 0
    do {
      const page = await call(chosen.serverId, SEARCH, { cloudId: chosen.cloud, jql, fields, maxResults: 100,
        ...(next ? { nextPageToken: next } : {}) })
      request.signal?.throwIfAborted()
      if (!Array.isArray(page?.issues) || page.warningMessages?.length || page.errorMessages?.length)
        throw new MemoryError(502, 'Jira no devolvió una página de issues válida para este alcance')
      if (page.isLast === true && page.nextPageToken) throw new MemoryError(502, 'Jira devolvió un final de paginación contradictorio')
      await onPage(page.issues, chosen.site)
      count += page.issues.length
      next = page.isLast === true ? undefined : page.nextPageToken
      if (!next && (page.isLast === false || (typeof page.total === 'number' && count < page.total) ||
        (page.isLast !== true && page.total === undefined && page.issues.length >= (page.maxResults ?? 100))))
        throw new MemoryError(502, 'Jira no devolvió el cursor para completar la sincronización')
      if (next && (typeof next !== 'string' || seen.has(next))) throw new MemoryError(502, 'Jira repitió un cursor de búsqueda')
      if (next) seen.add(next)
    } while (next)
  }
}
