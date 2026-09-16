/**
 * Catálogo inicial: los MCP servers que la app trae de fábrica para que una persona
 * que la instala tenga una base andando sin cargar nada a mano.
 *
 * Criterio de entrada: servidor remoto público del proveedor, ya sea con OAuth y registro
 * dinámico de cliente (RFC 7591) comprobado, así que basta «Conectar cuenta», o sin
 * autenticación (sujeto a los límites de uso del proveedor). Quedan afuera los que exigen
 * un client ID propio (Google, Slack, HubSpot) y cualquier server personal o interno de
 * una organización.
 *
 * Cada entrada declara en `since` la versión del catálogo que la introdujo. Un arranque
 * siembra sólo las entradas posteriores a la última versión aplicada y cuyo slug no exista:
 * si la persona borra un server de fábrica, ni el siguiente arranque ni una versión nueva
 * del catálogo lo reponen.
 */
import type { ServerAuth } from '@agenthub/shared'
import type { Store } from '../store.js'
import type { User } from '../types.js'

export const STARTER_CATALOG_VERSION = 2
export const STARTER_CATALOG_SETTING = 'starter_catalog_version'

export interface StarterServer {
  slug: string
  display_name: string
  description: string
  url: string
  /** `oauth`: la persona autoriza la cuenta desde la consola; `none`: sin credenciales. */
  auth: ServerAuth
  /** Versión del catálogo que introdujo la entrada. */
  since: number
}

export const STARTER_SERVERS: readonly StarterServer[] = [
  { slug: 'atlassian-rovo', display_name: 'Atlassian Rovo', description: 'MCP remoto de Atlassian (Jira y Confluence). Requiere autorizar la cuenta.', url: 'https://mcp.atlassian.com/v1/mcp/authv2', auth: 'oauth', since: 1 },
  { slug: 'notion', display_name: 'Notion', description: 'MCP remoto de Notion. Requiere autorizar la cuenta.', url: 'https://mcp.notion.com/mcp', auth: 'oauth', since: 1 },
  { slug: 'supabase', display_name: 'Supabase', description: 'MCP remoto de Supabase. Requiere autorizar la cuenta.', url: 'https://mcp.supabase.com/mcp', auth: 'oauth', since: 1 },
  { slug: 'cloudflare-developer-platform', display_name: 'Cloudflare Developer Platform', description: 'MCP remoto de Cloudflare. Requiere autorizar la cuenta.', url: 'https://bindings.mcp.cloudflare.com/mcp', auth: 'oauth', since: 1 },
  { slug: 'datadog', display_name: 'Datadog', description: 'MCP remoto de Datadog (endpoint en vista previa del proveedor). Requiere autorizar la cuenta.', url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp', auth: 'oauth', since: 1 },
  { slug: 'canva', display_name: 'Canva', description: 'MCP remoto de Canva. Requiere autorizar la cuenta.', url: 'https://mcp.canva.com/mcp', auth: 'oauth', since: 1 },
  { slug: 'port-io', display_name: 'Port IO', description: 'MCP remoto de Port. Requiere autorizar la cuenta.', url: 'https://mcp.port.io/v1', auth: 'oauth', since: 1 },
  { slug: 'tactiq', display_name: 'Tactiq', description: 'MCP remoto de Tactiq. Requiere autorizar la cuenta.', url: 'https://mcp.tactiq.io', auth: 'oauth', since: 1 },
  { slug: 'diio', display_name: 'diio', description: 'MCP remoto de diio. Requiere autorizar la cuenta.', url: 'https://login.diio.com/mcp/external/handle_server', auth: 'oauth', since: 1 },
  { slug: 'aws-knowledge', display_name: 'AWS Knowledge', description: 'MCP remoto oficial de AWS: documentación actualizada, referencias de API, novedades y blogs, guía Well-Architected, resolución de problemas, referencias de CDK y CloudFormation, disponibilidad regional de servicios y APIs, y skills de agente de AWS. No requiere cuenta de AWS ni autorización; sujeto a límites de uso.', url: 'https://knowledge-mcp.global.api.aws', auth: 'none', since: 2 },
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
    if (server.since <= applied) continue
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
      auth: server.auth,
    })
    outcome.added.push(server.slug)
  }
  store.setSetting(STARTER_CATALOG_SETTING, String(STARTER_CATALOG_VERSION))
  return outcome
}
