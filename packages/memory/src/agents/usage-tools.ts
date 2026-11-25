import { CLI_KINDS } from '@agenthub/shared'
import { UsageQuotas } from './usage-quotas.js'
import { UsageNotices } from './usage-notices.js'
import { callConsumptionTool } from './usage-consumption/tools.js'
import { LocalChat } from './local-chat.js'
import { z } from 'zod'
import { check } from '../contracts.js'
import type { AgentContext } from '../agents.js'

export const quotaReadOperations = ['usage_status'] as const satisfies readonly (keyof typeof usageDefinitions)[]

export const usageDefinitions = {
  usage_status: ['Native quotas and team notices: windows, resets, source, freshness. Unknown does not mean available; quota guarantees neither access nor completion. No inference or provider refresh.', z.object({session_key:z.string().min(32).max(200).optional(),cli:z.enum(CLI_KINDS).optional(),model:z.string().max(300).optional()}).strict()],
} satisfies Record<string, [string, z.ZodType]>

export async function callUsageTool(services: {chat: LocalChat; usage: UsageQuotas; usageNotices: UsageNotices; collaborationEnabled(): boolean}, operation: string, input: any, agent?: AgentContext) {
  switch (operation) {
    case 'usage_status': {
      const who=agent && input.session_key && services.collaborationEnabled() ? await services.chat.identity(agent,input.session_key) : undefined
      if(who)check(!who.closed_at && !who.removed_at,'La sesión de colaboración está cerrada',403)
      const clis=await Promise.all((input.cli ? [input.cli] : CLI_KINDS).map(async (cli:string)=>({cli,...await services.usage.forCli(cli,input.model)})))
      return {generated_at:new Date().toISOString(),clis,notices:who ? await services.usageNotices.pending(who.id,true) : [],
        guidance:'Shared quotas do not multiply per agent. Report window percentages and resets even if the aggregate state is unknown; tell unverified specific scope apart from no reading. Unknown or stale data does not prove availability. Keep progress; agree composition changes within current authorization.'}
    }
    case 'usage_self': case 'usage_team': return callConsumptionTool(operation, input, agent, { chat: services.chat, db: services.chat.db })
  }
}
