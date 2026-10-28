import { randomUUID } from 'node:crypto'
import { UpstreamSpec, type CallResult, type CallTrace, type ConnectionPool } from '@agenthub/gateway'
import { argsDigest } from '@agenthub/shared'
import { computeSnapshot } from '../policy/resolver.js'
import type { Store } from '../store.js'
import { ensureRunProfileAgent } from './identities.js'

/** La herramienta no está habilitada para la identidad de servicio en ese servidor: la llamada no llegó a salir. */
export class EffectToolDenied extends Error {
  constructor(readonly tool: string, readonly reason: 'tool_off' | 'no_identity') { super(`herramienta no habilitada para la identidad de efectos: ${tool}`) }
}

/** Herramientas de UN servidor del catálogo del dueño. Guard, lectura y escritura de una misma intención usan el mismo objeto y, por tanto, la misma conexión. */
export interface EffectTools {
  readonly server_id: string
  /** Vigente según las reglas del dueño y la cota del perfil, evaluado en este instante y solo dentro de este servidor. */
  enabled(name: string): boolean
  /** Lanza `EffectToolDenied` sin tocar la red si la herramienta no está habilitada en este servidor. */
  call(name: string, args: Record<string, unknown>): Promise<CallResult>
}

export interface EffectToolResolver {
  /** Ids de los servidores que publican TODAS estas herramientas habilitadas para `hub_effects` ahora mismo. */
  candidates(toolNames: readonly string[]): string[]
  forServer(serverId: string, trace?: CallTrace): EffectTools
}

/**
 * Resolvedor de la identidad de servicio `hub_effects`. El snapshot se recalcula en cada consulta y en cada llamada, de modo que
 * apagar o poner en cuarentena una herramienta surte efecto aun a mitad de un ciclo, y una herramienta apagada en un servidor
 * nunca se atiende desde otro que publique el mismo nombre.
 */
export function createEffectToolResolver(store: Store, pool: ConnectionPool, ownerId: string): EffectToolResolver {
  const snapshotServers = () => {
    const agent = ensureRunProfileAgent(store, ownerId, 'hub_effects')
    return agent ? { agent, servers: computeSnapshot(store, agent.id).servers } : undefined
  }
  const has = (server: { tools: { name: string }[] }, name: string) => server.tools.some(tool => tool.name.toLowerCase() === name.toLowerCase())
  return {
    candidates(toolNames) {
      const snapshot = snapshotServers()
      return snapshot ? snapshot.servers.filter(server => toolNames.every(name => has(server, name))).map(server => server.id) : []
    },
    forServer(serverId, trace = {}) {
      const denyRow = (name: string, args: Record<string, unknown>, reason: string, agentId: string | null, slug: string) => {
        const owner = store.user(ownerId)
        if (!owner) return
        store.insertToolCall({
          organization_id: owner.organization_id, agent_instance_id: agentId, user_id: owner.id, server_slug: slug, tool_name: name, exposed_name: '', decision: 'deny',
          denial_reason: reason, args_digest: argsDigest(args), duration_ms: 0, error: '', principal: 'hub_effects', call_id: trace.callId ?? null, run_id: trace.runId ?? null, intent_id: trace.intentId ?? null,
        })
      }
      return {
        server_id: serverId,
        enabled: name => { const snapshot = snapshotServers(); const server = snapshot?.servers.find(candidate => candidate.id === serverId); return !!server && has(server, name) },
        async call(name, args) {
          const snapshot = snapshotServers()
          const server = snapshot?.servers.find(candidate => candidate.id === serverId)
          const tool = server?.tools.find(candidate => candidate.name.toLowerCase() === name.toLowerCase())
          if (!snapshot || !server || !tool) {
            const reason = snapshot ? 'tool_off' : 'no_identity'
            denyRow(name, args, reason, snapshot?.agent.id ?? null, server?.slug ?? '')
            throw new EffectToolDenied(name, reason)
          }
          return pool.callTool(snapshot.agent.id, new UpstreamSpec(server), tool.name, args, undefined, { ...trace, callId: randomUUID() })
        },
      }
    },
  }
}
