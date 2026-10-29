import { resultText, type CallResult } from '@agenthub/gateway'
import type { ActionReceipt, JiraEffect } from '@agenthub/memory'
import { EffectRejected, type ActionAdapter, type ActionContext } from './executor.js'
import { EffectToolDenied } from './tools.js'

type Receipt = Omit<ActionReceipt, 'intent_id'>
type WorklogEffect = Extract<JiraEffect, { kind: 'jira_worklog' }>
type TransitionEffect = Extract<JiraEffect, { kind: 'jira_transition' }>
type CommentEffect = Extract<JiraEffect, { kind: 'jira_comment' }>

const USER_INFO = 'atlassianUserInfo'
const GET_ISSUE = 'getJiraIssue'
const GET_TRANSITIONS = 'getTransitionsForJiraIssue'
const ADD_WORKLOG = 'addWorklogToJiraIssue'
const TRANSITION = 'transitionJiraIssue'
const ADD_COMMENT = 'addCommentToJiraIssue'

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/
const REMOTE_ID = /^\d{1,20}$/
const HOUR_STEP_SECONDS = 1800
const MAX_TEXT = 4000

export interface JiraAdapterOptions {
  /**
   * Servidor del catálogo que atiende cada sitio Jira. Con más de un servidor Atlassian publicando las herramientas, devolver `undefined`
   * deja la intención en `ambiguous_server` antes de cualquier lectura o escritura.
   */
  serverId?: (site: string | null) => string | undefined
}

/** Origen `https://<sitio>.atlassian.net` sin credenciales ni puerto; es lo único que se acepta como `cloudId`. */
function siteOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && url.hostname.endsWith('.atlassian.net') && !url.username && !url.password && !url.port && url.origin === raw ? url.origin : null
  } catch { return null }
}

function common(raw: unknown, kind: JiraEffect['kind']): Record<string, unknown> {
  const value = raw as Record<string, unknown> | null
  if (!value || typeof value !== 'object' || value['kind'] !== kind) throw new Error('kind')
  if (typeof value['issue_key'] !== 'string' || !ISSUE_KEY.test(value['issue_key'])) throw new Error('issue_key')
  if (value['site'] !== null && !siteOrigin(value['site'])) throw new Error('site')
  if (value['account_id'] !== null && !(typeof value['account_id'] === 'string' && ACCOUNT_ID.test(value['account_id']))) throw new Error('account_id')
  return value
}

const text = (value: unknown, max: number): string => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('text'); return value }

const worklogEffect = { parse(raw: unknown): WorklogEffect {
  const value = common(raw, 'jira_worklog')
  const seconds = value['seconds']
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < HOUR_STEP_SECONDS || seconds % HOUR_STEP_SECONDS !== 0) throw new Error('seconds')
  if (Number.isNaN(Date.parse(text(value['started'], 64)))) throw new Error('started')
  return { ...value, seconds, started: value['started'] as string, marker: text(value['marker'], 300), estimate_id: text(value['estimate_id'], 100) } as WorklogEffect
} }

const transitionEffect = { parse(raw: unknown): TransitionEffect {
  const value = common(raw, 'jira_transition')
  if (value['to_category'] !== 'done') throw new Error('to_category')
  if (value['to_name'] !== null && typeof value['to_name'] !== 'string') throw new Error('to_name')
  return { ...value, evidence_ref: text(value['evidence_ref'], 200) } as TransitionEffect
} }

const commentEffect = { parse(raw: unknown): CommentEffect {
  const value = common(raw, 'jira_comment')
  return { ...value, text: text(value['text'], MAX_TEXT), evidence_ref: text(value['evidence_ref'], 200) } as CommentEffect
} }

function payload(result: CallResult): Record<string, any> | undefined {
  if (result.structured_content) return result.structured_content
  try { const parsed = JSON.parse(resultText(result)); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined } catch { return undefined }
}

/** Lectura previa a una escritura. Todo fallo, también uno de red, significa que nada se escribió y sale como rechazo. */
async function read(ctx: ActionContext, tool: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  let result: CallResult
  try { result = await ctx.tools.call(tool, args) } catch (error) { throw new EffectRejected(error instanceof EffectToolDenied ? 'tool_off' : 'read_failed') }
  const data = result.is_error ? undefined : payload(result)
  if (!data) throw new EffectRejected(result.is_error ? 'read_tool_error' : 'read_unparsed')
  return data
}

/** Texto plano de un cuerpo que puede ser markdown (cadena) o ADF (árbol con `text` y `content`). */
function plain(node: unknown, depth = 0): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object' || depth > 24) return ''
  const value = node as { text?: unknown; content?: unknown }
  return `${typeof value.text === 'string' ? value.text : ''}${Array.isArray(value.content) ? value.content.map(child => plain(child, depth + 1)).join('\n') : ''}`
}

/** Entradas de un historial paginado; `complete` solo es verdadero si el servidor informa un `total` y todas las entradas llegaron. */
function history(container: unknown, list: 'worklogs' | 'comments'): { items: Record<string, any>[]; complete: boolean } {
  const value = container as Record<string, any> | undefined
  const items = value?.[list]
  if (!Array.isArray(items)) return { items: [], complete: false }
  return { items, complete: typeof value?.['total'] === 'number' && items.length >= value['total'] }
}

interface Guarded {
  cloud: string
  issue: Record<string, any>
}

/**
 * Guard de identidad y de asignado, vigente en el instante de la llamada: `atlassianUserInfo` debe devolver exactamente el `account_id`
 * fijado en el efecto aprobado y el ticket debe estar asignado a esa misma cuenta. Una cuenta sin fijar, un asignado vacío o cualquier
 * diferencia rechaza antes de escribir. Se ejecuta en `prepare` y otra vez justo antes de cada escritura.
 */
async function guard(ctx: ActionContext, effect: JiraEffect, fields: string[]): Promise<Guarded> {
  const cloud = effect.site
  if (!cloud) throw new EffectRejected('site_unknown')
  if (!effect.account_id) throw new EffectRejected('account_unpinned')
  const info = await read(ctx, USER_INFO, {})
  const account = info['account_id']
  if (typeof account !== 'string' || !ACCOUNT_ID.test(account)) throw new EffectRejected('identity_unverified')
  if (account !== effect.account_id) throw new EffectRejected('account_mismatch')
  const issue = await read(ctx, GET_ISSUE, { cloudId: cloud, issueIdOrKey: effect.issue_key, fields: ['assignee', 'status', ...fields], responseContentFormat: 'markdown' })
  if (String(issue['key'] ?? '').toUpperCase() !== effect.issue_key) throw new EffectRejected('issue_mismatch')
  const assignee = issue['fields']?.['assignee']?.['accountId']
  if (typeof assignee !== 'string') throw new EffectRejected('issue_unassigned')
  if (assignee !== account) throw new EffectRejected('assignee_mismatch')
  return { cloud, issue }
}

const statusCategory = (issue: Record<string, any>): string | null => {
  const key = issue['fields']?.['status']?.['statusCategory']?.['key']
  return typeof key === 'string' ? key : null
}

/** Referencia que se escribe en el cuerpo y que permite reconocer la escritura propia al reconciliar; ayuda de reconciliación, no garantía. */
const reference = (ctx: ActionContext) => `ref ${ctx.intent_id}`

/** Identificador devuelto por una escritura: solo un campo estructurado numérico cuenta como recibo. */
function remoteId(result: CallResult, keys: string[]): string | null {
  const data = payload(result)
  if (!data) return null
  for (const source of [data, data['worklog'], data['comment']]) {
    for (const key of keys) {
      const candidate = (source as Record<string, unknown> | undefined)?.[key]
      if (typeof candidate === 'number') return REMOTE_ID.test(String(candidate)) ? String(candidate) : null
      if (typeof candidate === 'string' && REMOTE_ID.test(candidate)) return candidate
    }
  }
  return null
}

/** Formato de `started` que acepta la herramienta: ISO 8601 con milisegundos y desfase `+0000`. */
const jiraInstant = (iso: string) => new Date(iso).toISOString().replace('Z', '+0000')

/**
 * Busca en un historial la entrada que lleva la referencia de la intención. `null` cuando no está y el historial es completo;
 * `'unknown'` cuando no se puede afirmar nada porque faltan entradas por leer.
 */
function findOwn(container: unknown, list: 'worklogs' | 'comments', ctx: ActionContext): string | null | 'unknown' {
  const { items, complete } = history(container, list)
  const hit = items.find(item => plain(item[list === 'worklogs' ? 'comment' : 'body']).includes(reference(ctx)))
  if (hit) return typeof hit['id'] === 'string' || typeof hit['id'] === 'number' ? String(hit['id']) : 'unknown'
  return complete ? null : 'unknown'
}

type Prepared<E> = { effect: E; existing: string | null; transition_id?: string }

function bound(options: JiraAdapterOptions) {
  return (effect: JiraEffect) => options.serverId?.(effect.site)
}

function worklogAdapter(options: JiraAdapterOptions): ActionAdapter<WorklogEffect> {
  const check = async (ctx: ActionContext, effect: WorklogEffect): Promise<Guarded & { existing: string | null }> => {
    const guarded = await guard(ctx, effect, ['worklog'])
    const found = findOwn(guarded.issue['fields']?.['worklog'], 'worklogs', ctx)
    if (found === 'unknown') throw new EffectRejected('history_incomplete')
    return { ...guarded, existing: found }
  }
  return {
    kind: 'jira_worklog',
    effect: worklogEffect,
    tools: [USER_INFO, GET_ISSUE, ADD_WORKLOG],
    server: bound(options),
    async prepare(ctx, effect) {
      const { existing } = await check(ctx, effect)
      return { effect, existing } satisfies Prepared<WorklogEffect>
    },
    async execute(ctx, raw): Promise<Receipt> {
      const { effect } = raw as Prepared<WorklogEffect>
      let checked
      try { checked = await check(ctx, effect) } catch (error) { return { state: 'rejected_before_dispatch', error_code: error instanceof EffectRejected ? error.code : 'guard_failed' } }
      if (checked.existing) return { state: 'succeeded', remote_ref: `${effect.issue_key}/worklog/${checked.existing}` }
      let result: CallResult
      try {
        result = await ctx.tools.call(ADD_WORKLOG, { cloudId: checked.cloud, issueIdOrKey: effect.issue_key, timeSpent: `${effect.seconds / 60}m`, started: jiraInstant(effect.started),
          commentBody: `${effect.marker} · ${reference(ctx)}`, contentFormat: 'markdown' })
      } catch (error) {
        return error instanceof EffectToolDenied ? { state: 'rejected_before_dispatch', error_code: 'tool_off' } : { state: 'uncertain', error_code: 'send_threw' }
      }
      if (result.is_error) return { state: 'uncertain', error_code: 'tool_error' }
      const id = remoteId(result, ['id', 'worklogId'])
      return id ? { state: 'succeeded', remote_ref: `${effect.issue_key}/worklog/${id}` } : { state: 'uncertain', error_code: 'receipt_unparsed' }
    },
    async reconcile(ctx, _intentId, effect): Promise<Receipt | null> {
      if (!effect.site) return null
      const issue = await read(ctx, GET_ISSUE, { cloudId: effect.site, issueIdOrKey: effect.issue_key, fields: ['worklog'], responseContentFormat: 'markdown' })
      const found = findOwn(issue['fields']?.['worklog'], 'worklogs', ctx)
      return typeof found === 'string' && found !== 'unknown' ? { state: 'succeeded', remote_ref: `${effect.issue_key}/worklog/${found}` } : null
    },
  } as ActionAdapter<WorklogEffect>
}

function commentAdapter(options: JiraAdapterOptions): ActionAdapter<CommentEffect> {
  const check = async (ctx: ActionContext, effect: CommentEffect): Promise<Guarded & { existing: string | null }> => {
    const guarded = await guard(ctx, effect, ['comment'])
    const found = findOwn(guarded.issue['fields']?.['comment'], 'comments', ctx)
    if (found === 'unknown') throw new EffectRejected('history_incomplete')
    return { ...guarded, existing: found }
  }
  return {
    kind: 'jira_comment',
    effect: commentEffect,
    tools: [USER_INFO, GET_ISSUE, ADD_COMMENT],
    server: bound(options),
    async prepare(ctx, effect) {
      const { existing } = await check(ctx, effect)
      return { effect, existing } satisfies Prepared<CommentEffect>
    },
    async execute(ctx, raw): Promise<Receipt> {
      const { effect } = raw as Prepared<CommentEffect>
      let checked
      try { checked = await check(ctx, effect) } catch (error) { return { state: 'rejected_before_dispatch', error_code: error instanceof EffectRejected ? error.code : 'guard_failed' } }
      if (checked.existing) return { state: 'succeeded', remote_ref: `${effect.issue_key}/comment/${checked.existing}` }
      let result: CallResult
      try {
        result = await ctx.tools.call(ADD_COMMENT, { cloudId: checked.cloud, issueIdOrKey: effect.issue_key, commentBody: `${effect.text}\n\n_Agent Hub · ${reference(ctx)}_`, contentFormat: 'markdown' })
      } catch (error) {
        return error instanceof EffectToolDenied ? { state: 'rejected_before_dispatch', error_code: 'tool_off' } : { state: 'uncertain', error_code: 'send_threw' }
      }
      if (result.is_error) return { state: 'uncertain', error_code: 'tool_error' }
      const id = remoteId(result, ['id', 'commentId'])
      return id ? { state: 'succeeded', remote_ref: `${effect.issue_key}/comment/${id}` } : { state: 'uncertain', error_code: 'receipt_unparsed' }
    },
    async reconcile(ctx, _intentId, effect): Promise<Receipt | null> {
      if (!effect.site) return null
      const issue = await read(ctx, GET_ISSUE, { cloudId: effect.site, issueIdOrKey: effect.issue_key, fields: ['comment'], responseContentFormat: 'markdown' })
      const found = findOwn(issue['fields']?.['comment'], 'comments', ctx)
      return typeof found === 'string' && found !== 'unknown' ? { state: 'succeeded', remote_ref: `${effect.issue_key}/comment/${found}` } : null
    },
  } as ActionAdapter<CommentEffect>
}

function transitionAdapter(options: JiraAdapterOptions): ActionAdapter<TransitionEffect> {
  /** Única transición disponible hacia la categoría «done»; con `to_name`, además debe llamarse así. Cero o varias rechazan. */
  const select = async (ctx: ActionContext, effect: TransitionEffect, cloud: string): Promise<string> => {
    const data = await read(ctx, GET_TRANSITIONS, { cloudId: cloud, issueIdOrKey: effect.issue_key })
    const all: Record<string, any>[] = Array.isArray(data['transitions']) ? data['transitions'] : []
    const wanted = effect.to_name?.trim().toLowerCase()
    const matches = all.filter(item => item['isAvailable'] !== false && item['to']?.['statusCategory']?.['key'] === 'done'
      && (!wanted || String(item['to']?.['name'] ?? '').trim().toLowerCase() === wanted) && typeof item['id'] === 'string' && REMOTE_ID.test(item['id']))
    if (matches.length === 0) throw new EffectRejected('transition_unavailable')
    if (matches.length > 1) throw new EffectRejected('transition_ambiguous')
    return matches[0]!['id']
  }
  const check = async (ctx: ActionContext, effect: TransitionEffect): Promise<Guarded & { transition_id: string }> => {
    const guarded = await guard(ctx, effect, [])
    if (statusCategory(guarded.issue) === 'done') throw new EffectRejected('already_done')
    return { ...guarded, transition_id: await select(ctx, effect, guarded.cloud) }
  }
  return {
    kind: 'jira_transition',
    effect: transitionEffect,
    tools: [USER_INFO, GET_ISSUE, GET_TRANSITIONS, TRANSITION],
    server: bound(options),
    async prepare(ctx, effect) {
      const { transition_id } = await check(ctx, effect)
      return { effect, existing: null, transition_id } satisfies Prepared<TransitionEffect>
    },
    async execute(ctx, raw): Promise<Receipt> {
      const { effect } = raw as Prepared<TransitionEffect>
      let checked
      try { checked = await check(ctx, effect) } catch (error) { return { state: 'rejected_before_dispatch', error_code: error instanceof EffectRejected ? error.code : 'guard_failed' } }
      let result: CallResult
      try { result = await ctx.tools.call(TRANSITION, { cloudId: checked.cloud, issueIdOrKey: effect.issue_key, transition: { id: checked.transition_id } }) } catch (error) {
        return error instanceof EffectToolDenied ? { state: 'rejected_before_dispatch', error_code: 'tool_off' } : { state: 'uncertain', error_code: 'send_threw' }
      }
      if (result.is_error) return { state: 'uncertain', error_code: 'tool_error' }
      // La respuesta de escritura no se interpreta: el recibo sale de releer el estado del ticket.
      try {
        const after = await read(ctx, GET_ISSUE, { cloudId: checked.cloud, issueIdOrKey: effect.issue_key, fields: ['status'] })
        return statusCategory(after) === 'done' ? { state: 'succeeded', remote_ref: `${effect.issue_key}/transition/${checked.transition_id}` } : { state: 'uncertain', error_code: 'not_confirmed' }
      } catch { return { state: 'uncertain', error_code: 'not_confirmed' } }
    },
    /** Solo lectura. Un ticket ya en «done» es evidencia del resultado buscado, no de quién lo movió; sin ese estado no hay prueba en ningún sentido. */
    async reconcile(ctx, _intentId, effect): Promise<Receipt | null> {
      const cloud = effect.site
      if (!cloud) return null
      const issue = await read(ctx, GET_ISSUE, { cloudId: cloud, issueIdOrKey: effect.issue_key, fields: ['status'] })
      return statusCategory(issue) === 'done' ? { state: 'succeeded', remote_ref: `${effect.issue_key}/status/done` } : null
    },
  } as ActionAdapter<TransitionEffect>
}

/** Los tres adaptadores de Jira para la lista cerrada del ejecutor. Escriben solo por el MCP de Atlassian del servidor fijado por el efecto. */
export function createJiraAdapters(options: JiraAdapterOptions = {}): ActionAdapter<any>[] {
  return [worklogAdapter(options), transitionAdapter(options), commentAdapter(options)]
}
