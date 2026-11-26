import { residentReadAnnotations } from '@agenthub/gateway'
import { computeSnapshot } from '../../policy/resolver.js'
import { moduleEnabled } from '../settings.js'
import type { Store } from '../../store.js'

/** The resident inherits only reads offered to this CLI on the machine running the terminal. */
export function assistantReadTools(store: Store, owner: string, hostname: string, provider: string, baseUrl: string) {
  if (!moduleEnabled(store, 'mcp')) return []
  const local = store.agentsOfUser(owner).find(({ agent, machine }) =>
    agent.enabled && agent.cli_kind === provider && machine.hostname === hostname)
  if (!local) return []
  return computeSnapshot(store, local.agent.id).servers.flatMap(server =>
    server.tools.filter(tool => residentReadAnnotations(server, tool.name, baseUrl)?.readOnlyHint).map(tool => tool.exposed_name))
}
