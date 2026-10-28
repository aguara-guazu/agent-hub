import type { PoolCallRecord } from '@agenthub/gateway'
import type { Store } from '../store.js'

const UI_PRINCIPAL_PREFIX = 'memory-ui:'

/**
 * Observador de `ConnectionPool.onCall` para el pool del core: cada llamada a un upstream deja una fila en `tool_call_logs`.
 *
 * El gateway ya reporta las llamadas de los agentes por `/api/sync/tool-call`; este observador cubre las que nacen en el
 * core (sincronización de Jira desde la UI y ejecutor de efectos), que no tienen ese camino. Sin `agent_instances` para
 * las identidades de la UI, `agent_instance_id` queda NULL y la identidad se guarda en `principal`.
 */
export function createPoolCallAudit(store: Store, ownerId: string): (record: PoolCallRecord) => void {
  return (record) => {
    const owner = store.user(ownerId)
    if (!owner) return
    const agent = record.agentId.startsWith(UI_PRINCIPAL_PREFIX) ? undefined : store.agent(record.agentId)
    store.insertToolCall({
      organization_id: owner.organization_id,
      agent_instance_id: agent?.id ?? null,
      user_id: owner.id,
      server_slug: record.serverSlug,
      tool_name: record.toolName,
      exposed_name: '',
      decision: 'allow',
      denial_reason: '',
      args_digest: record.argsDigest,
      duration_ms: record.durationMs,
      error: record.error || (record.isError ? 'tool_error' : ''),
      principal: agent?.cli_kind ?? (record.agentId.startsWith(UI_PRINCIPAL_PREFIX) ? 'memory-ui' : record.agentId),
      call_id: record.trace.callId ?? null,
      run_id: record.trace.runId ?? null,
      intent_id: record.trace.intentId ?? null,
    })
  }
}
