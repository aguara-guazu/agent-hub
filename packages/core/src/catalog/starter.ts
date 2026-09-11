/**
 * Catálogo inicial: los MCP servers que la app trae de fábrica para que una persona
 * que la instala tenga una base andando sin cargar nada a mano.
 *
 * Criterio de entrada: servidor remoto público del proveedor, con OAuth y registro
 * dinámico de cliente (RFC 7591) comprobado, así que basta «Conectar cuenta». Quedan
 * afuera los que exigen un client ID propio (Google, Slack, HubSpot) y cualquier server
 * personal o interno de una organización.
 *
 * Se aplica UNA vez por versión del catálogo y sólo agrega slugs que no existan: si la
 * persona borra un server de fábrica, no vuelve a aparecer en el próximo arranque.
 */
import type { Store } from '../store.js'
import type { User } from '../types.js'

export const STARTER_CATALOG_VERSION = 1
export const STARTER_CATALOG_SETTING = 'starter_catalog_version'

export interface StarterServer {
  slug: string
  display_name: string
  description: string
  url: string
}

export const STARTER_SERVERS: readonly StarterServer[] = [
  { slug: 'atlassian-rovo', display_name: 'Atlassian Rovo', description: 'MCP remoto de Atlassian (Jira y Confluence). Requiere autorizar la cuenta.', url: 'https://mcp.atlassian.com/v1/mcp/authv2' },
  { slug: 'notion', display_name: 'Notion', description: 'MCP remoto de Notion. Requiere autorizar la cuenta.', url: 'https://mcp.notion.com/mcp' },
  { slug: 'supabase', display_name: 'Supabase', description: 'MCP remoto de Supabase. Requiere autorizar la cuenta.', url: 'https://mcp.supabase.com/mcp' },
  { slug: 'cloudflare-developer-platform', display_name: 'Cloudflare Developer Platform', description: 'MCP remoto de Cloudflare. Requiere autorizar la cuenta.', url: 'https://bindings.mcp.cloudflare.com/mcp' },
  { slug: 'datadog', display_name: 'Datadog', description: 'MCP remoto de Datadog (endpoint en vista previa del proveedor). Requiere autorizar la cuenta.', url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp' },
  { slug: 'canva', display_name: 'Canva', description: 'MCP remoto de Canva. Requiere autorizar la cuenta.', url: 'https://mcp.canva.com/mcp' },
  { slug: 'port-io', display_name: 'Port IO', description: 'MCP remoto de Port. Requiere autorizar la cuenta.', url: 'https://mcp.port.io/v1' },
  { slug: 'tactiq', display_name: 'Tactiq', description: 'MCP remoto de Tactiq. Requiere autorizar la cuenta.', url: 'https://mcp.tactiq.io' },
  { slug: 'diio', display_name: 'diio', description: 'MCP remoto de diio. Requiere autorizar la cuenta.', url: 'https://login.diio.com/mcp/external/handle_server' },
]

export interface StarterOutcome {
  version: number
  added: string[]
  skipped: string[]
  /** `true` si esta versión ya se había aplicado y no se tocó nada. */
  alreadyApplied: boolean
}

export function applyStarterCatalog(store: Store, owner: User, servers: readonly StarterServer[] = STARTER_SERVERS): StarterOutcome {
  const applied = Number.parseInt(store.setting(STARTER_CATALOG_SETTING) ?? '0', 10) || 0
  if (applied >= STARTER_CATALOG_VERSION) return { version: applied, added: [], skipped: [], alreadyApplied: true }

  const outcome: StarterOutcome = { version: STARTER_CATALOG_VERSION, added: [], skipped: [], alreadyApplied: false }
  for (const server of servers) {
    if (store.serverBySlug(owner.id, server.slug)) {
      outcome.skipped.push(server.slug)
      continue
    }
    store.insertServer({
      user_id: owner.id,
      slug: server.slug,
      display_name: server.display_name,
      description: server.description,
      transport: 'http',
      command: '',
      args: [],
      env: {},
      cwd: '',
      url: server.url,
      headers: {},
      secret_refs: {},
      requires_host_access: false,
      container_image: '',
      allow_hosts: [],
      allow_ports: [],
      read_mounts: [],
      write_mounts: [],
      auth: 'oauth',
    })
    outcome.added.push(server.slug)
  }
  store.setSetting(STARTER_CATALOG_SETTING, String(STARTER_CATALOG_VERSION))
  return outcome
}
