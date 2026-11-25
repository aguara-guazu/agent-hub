import type { ModuleEnabled } from '@agenthub/shared/modules'
import type { LegacyGatewayScan } from './update-drain.js'
import type { FastifyRequest } from 'fastify'

export type OwnerGuard = (request: FastifyRequest) => Promise<void>
export interface MemoryRouteOptions {
  moduleEnabled?: ModuleEnabled
  directory: string; baseUrl: string;
  authorize(request: FastifyRequest): Promise<{ id: string }>
  /** Authorization exclusive to the desktop's update drain; absent refuses every request. */
  authorizeUpdate?(request: FastifyRequest): Promise<void>
  /** Transaction of the update that launched this core: it starts closed until the desktop admits it. */
  updateTransaction?: string
  /** Scan of gateways started from a bundle older than the versioned runtime; logged by an update stop, never blocking. */
  legacyGateways?(): Promise<LegacyGatewayScan>
  collaborationEnabled?(): boolean
  chatAgentEnabled?(agentId: string): boolean
  usageAgentEnabled?(agentId: string): boolean
  authorizeUsageAgent?(request: FastifyRequest, agentId: string): Promise<{ cli_kind: string }>
  authorizeChatAgent?(request: FastifyRequest, agentId: string): Promise<{ cli_kind: string }>
  worker?: boolean
  jiraMcp?: import('./projects/tasks.js').JiraTaskReader
  /** Switch of the scheduler and the effects the core injects (deliveries, approved actions, decisions); absent means enabled and no external adapters. */
  automationsEnabled?(): boolean
  scheduleEffects?: import('./schedules/schedule-contract.js').ScheduleEffects
}
