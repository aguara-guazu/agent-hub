/**
 * Puente del gateway con la memoria local de Agent Hub.
 *
 * - Identidad: cada llamada al MCP de memoria lleva en `_meta` el agente, el cliente, la
 *   sesion (un proceso de gateway) y la carpeta de trabajo. La memoria la usa para
 *   atribuir notas y resolver el proyecto de la carpeta. Nunca viaja a otros servers.
 * - Espejo de Jira: despues de cada llamada exitosa a una herramienta de Jira de otro
 *   server, los issues del resultado (y el estado fresco del issue escrito, releido con
 *   getJiraIssue) se guardan en las tareas locales con `sync_tasks`. Un fallo del espejo
 *   nunca cambia el resultado que recibe el agente.
 */

import type { CallResult, UpstreamSpec } from './runtime.js'

export const MEMORY_META_KEY = 'agenthub/agent'
const MEMORY_PATH = '/api/memory/mcp'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/
/** Herramientas de Jira que cambian un issue (MCP de Atlassian y mcp-atlassian): su resultado no siempre trae el estado nuevo. */
const JIRA_WRITES = new Set(['createjiraissue', 'editjiraissue', 'transitionjiraissue', 'addcommenttojiraissue', 'addworklogtojiraissue',
  'jira_create_issue', 'jira_update_issue', 'jira_transition_issue', 'jira_add_comment', 'jira_add_worklog'])
/** Lectura de un issue con la que se relee el estado despues de una escritura. */
export const JIRA_REREADS = ['getjiraissue', 'jira_get_issue']
const REREAD_FIELDS = ['summary', 'description', 'status', 'issuetype', 'priority', 'assignee', 'updated', 'project']

export function isMemorySpec(spec: UpstreamSpec): boolean {
  if (!spec.url) return false
  try {
    const url = new URL(spec.url)
    return LOOPBACK.has(url.hostname) && url.pathname.replace(/\/+$/, '') === MEMORY_PATH
  } catch {
    return false
  }
}

export function isJiraTool(toolName: string): boolean {
  return /jira/i.test(toolName)
}

export function isJiraWrite(toolName: string): boolean {
  return JIRA_WRITES.has(toolName.toLowerCase())
}

function parseContent(result: CallResult): unknown[] {
  const values: unknown[] = []
  if (result.structured_content) values.push(result.structured_content)
  for (const item of result.content) {
    if (item['type'] !== 'text' || typeof item['text'] !== 'string') continue
    try {
      values.push(JSON.parse(item['text']))
    } catch {
      // Texto libre: no hay issues que reflejar.
    }
  }
  return values
}

/** Issues con forma REST de Jira (`key` + `fields`) en cualquier nivel poco profundo del resultado. */
export function issuesIn(result: CallResult): Record<string, unknown>[] {
  const found = new Map<string, Record<string, unknown>>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    const row = value as Record<string, unknown>
    const fields = row['fields'] && typeof row['fields'] === 'object' ? row['fields'] as Record<string, unknown> : row
    if (typeof row['key'] === 'string' && ISSUE_KEY.test(row['key']) && fields['status'] && fields['summary']) {
      found.set(row['key'], row)
      return
    }
    for (const nested of Object.values(row)) visit(nested, depth + 1)
  }
  for (const value of parseContent(result)) visit(value, 0)
  return [...found.values()]
}

/** La clave del issue que una escritura toco: el argumento, o la que devuelve una creacion. */
export function writtenKey(args: Record<string, unknown>, result: CallResult): string | undefined {
  const raw = args['issueIdOrKey'] ?? args['issue_key']
  const fromArgs = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  if (ISSUE_KEY.test(fromArgs)) return fromArgs
  if (/^\d+$/.test(fromArgs)) return fromArgs
  for (const value of parseContent(result)) {
    if (value && typeof value === 'object' && typeof (value as Record<string, unknown>)['key'] === 'string') {
      const key = String((value as Record<string, unknown>)['key'])
      if (ISSUE_KEY.test(key)) return key
    }
  }
  return undefined
}

/** Argumentos de la relectura segun el MCP: el de Atlassian pide `cloudId`; mcp-atlassian, `issue_key`. */
export function rereadArgs(toolName: string, args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (toolName.toLowerCase() === 'jira_get_issue') return { issue_key: key, fields: REREAD_FIELDS.join(',') }
  return typeof args['cloudId'] === 'string' ? { cloudId: args['cloudId'], issueIdOrKey: key, fields: REREAD_FIELDS } : undefined
}

/** Un `cloudId` que es el host del sitio permite armar el enlace al issue. */
export function siteFromArgs(args: Record<string, unknown>): string | undefined {
  const cloud = typeof args['cloudId'] === 'string' ? args['cloudId'].trim() : ''
  const host = cloud.replace(/^https:\/\//, '').replace(/\/.*$/, '')
  return /^[a-z0-9-]+\.atlassian\.net$/i.test(host) ? `https://${host.toLowerCase()}` : undefined
}

/** Rovo accepts a cloud UUID as well as a URL; resolve that UUID without guessing a tenant. */
export function siteFromResources(result: CallResult, cloudId: string): string | undefined {
  const visit = (value: unknown, depth = 0): string | undefined => {
    if (!value || typeof value !== 'object' || depth > 5) return undefined
    const row = value as Record<string, unknown>
    if (row['id'] === cloudId && typeof row['url'] === 'string') return siteFromArgs({ cloudId: row['url'] })
    for (const nested of Object.values(row)) { const site = visit(nested, depth + 1); if (site) return site }
    return undefined
  }
  for (const value of parseContent(result)) { const site = visit(value); if (site) return site }
  return undefined
}
