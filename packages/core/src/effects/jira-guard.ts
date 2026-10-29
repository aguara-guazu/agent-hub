import type { JiraGuard } from '@agenthub/memory'
import { JIRA_ACCOUNT_ID, JIRA_GET_ISSUE_TOOL, JIRA_ISSUE_KEY, JIRA_USER_INFO_TOOL, jiraRead, resolveJiraSite } from './jira.js'
import type { EffectTools } from './tools.js'

export interface JiraGuardOptions {
  /** Servidor de Jira fijado por el dueño; se evalúa en cada llamada, de modo que un cambio del setting se ve sin reiniciar. */
  serverId: () => string | undefined
  /** Herramientas `hub_effects` de ese servidor; cada llamada queda en `tool_call_logs` con el principal `hub_effects`. */
  tools: (serverId: string) => EffectTools
}

/**
 * Identidad de Jira del dueño para armar propuestas de escritura. La cuenta sale solo de `atlassianUserInfo` y el asignado solo de `getJiraIssue`, ambos por el mismo servidor
 * y con la identidad de efectos; nunca del nombre visible del espejo. Sin servidor, con una herramienta apagada o ante cualquier error la respuesta es «sin verificar»
 * (`null` o `verified: false`): no se infiere nada. No guarda nada entre llamadas. Es una lectura previa a la propuesta; el adaptador de escritura vuelve a verificar al ejecutar.
 */
export function createJiraGuard(options: JiraGuardOptions): JiraGuard {
  const context = () => { const id = options.serverId(); return id ? { tools: options.tools(id) } : undefined }
  const ownerAccountId = async (ctx: { tools: EffectTools }): Promise<string | null> => {
    const account = (await jiraRead(ctx, JIRA_USER_INFO_TOOL, {}))['account_id']
    return typeof account === 'string' && JIRA_ACCOUNT_ID.test(account) ? account : null
  }
  return {
    configured: () => options.serverId() !== undefined,
    async ownerAccountId() {
      const ctx = context()
      if (!ctx) return null
      try { return await ownerAccountId(ctx) } catch { return null }
    },
    async assigneeOf(issueKey) {
      const ctx = context()
      const unverified = { account_id: null, verified: false }
      if (!ctx || !JIRA_ISSUE_KEY.test(issueKey)) return unverified
      try {
        const cloud = await resolveJiraSite(ctx, { site: null })
        const issue = await jiraRead(ctx, JIRA_GET_ISSUE_TOOL, { cloudId: cloud, issueIdOrKey: issueKey, fields: ['assignee'], responseContentFormat: 'markdown' })
        if (String(issue['key'] ?? '').toUpperCase() !== issueKey) return unverified
        const assignee = issue['fields']?.['assignee']
        if (assignee === null) return { account_id: null, verified: true }
        const account = assignee?.['accountId']
        return typeof account === 'string' && JIRA_ACCOUNT_ID.test(account) ? { account_id: account, verified: true } : unverified
      } catch { return unverified }
    },
  }
}
