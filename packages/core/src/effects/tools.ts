import { randomUUID } from 'node:crypto'
import { UpstreamSpec, type CallResult, type CallTrace, type ConnectionPool } from '@agenthub/gateway'
import { argsDigest } from '@agenthub/shared'
import { computeSnapshot } from '../policy/resolver.js'
import type { Store } from '../store.js'
import { ensureRunProfileAgent } from './identities.js'

/** La herramienta no está habilitada para la identidad de servicio: la llamada no llegó a salir. */
export class EffectToolDenied extends Error {
  constructor(readonly tool: string, readonly reason: 'tool_off' | 'no_identity') { super(`herramienta no habilitada para la identidad de efectos: ${tool}`) }
}

/** Herramientas MCP del dueño tal como las ve la identidad `hub_effects`. El ejecutor nunca recibe un nombre de herramienta de un llamador. */
export interface EffectTools {
  /** Vigente según las reglas del dueño y la cota del perfil, evaluado en este instante. */
  enabled(name: string): boolean
  /** Lanza `EffectToolDenied` sin tocar la red si la herramienta no está habilitada. */
  call(name: string, args: Record<string, unknown>): Promise<CallResult>
}

/**
 * Resolvedor de la identidad de servicio `hub_effects`. El snapshot se recalcula en cada consulta y en cada llamada,
 * de modo que apagar o poner en cuarentena una herramienta surte efecto aun a mitad de un ciclo.
 */
export function createEffectTools(store: Store, pool: ConnectionPool, ownerId: string, trace: CallTrace = {}): EffectTools {
  const resolve = (name: string) => {
    const agent = ensureRunProfileAgent(store, ownerId, 'hub_effects')
    if (!agent) return { agent: undefined, server: undefined }
    const wanted = name.toLowerCase()
    const server = computeSnapshot(store, agent.id).servers.find(candidate => candidate.tools.some(tool => tool.name.toLowerCase() === wanted))
    return { agent, server, tool: server?.tools.find(tool => tool.name.toLowerCase() === wanted) }
  }
  const denyRow = (name: string, args: Record<string, unknown>, reason: string, agentId: string | null) => {
    const owner = store.user(ownerId)
    if (!owner) return
    store.insertToolCall({
      organization_id: owner.organization_id, agent_instance_id: agentId, user_id: owner.id, server_slug: '', tool_name: name, exposed_name: '', decision: 'deny',
      denial_reason: reason, args_digest: argsDigest(args), duration_ms: 0, error: '', principal: 'hub_effects', call_id: trace.callId ?? null, run_id: trace.runId ?? null, intent_id: trace.intentId ?? null,
    })
  }
  return {
    enabled: name => resolve(name).tool !== undefined,
    async call(name, args) {
      const { agent, server, tool } = resolve(name)
      if (!agent || !server || !tool) {
        denyRow(name, args, agent ? 'tool_off' : 'no_identity', agent?.id ?? null)
        throw new EffectToolDenied(name, agent ? 'tool_off' : 'no_identity')
      }
      return pool.callTool(agent.id, new UpstreamSpec(server), tool.name, args, undefined, { ...trace, callId: randomUUID() })
    },
  }
}
