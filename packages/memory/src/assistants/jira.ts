import type { ModuleEnabled } from '@agenthub/shared/modules'
import { check } from '../contracts.js'
import { effectiveJiraSite, jiraSiteUrl } from '../connectors/jira-settings.js'
import type { Sql } from '../database.js'
import { mapJiraStatus, normalizeJiraIssue, type JiraIssue, type JiraTaskReader } from '../projects/tasks.js'
import { terms } from './context.js'
import type { CaseRow, Evidence, Profile } from './contracts.js'

export type JiraCase = Pick<CaseRow, 'kind' | 'title' | 'source' | 'source_key'>
export interface LiveEvidence {
  status: 'verified' | 'not_visible' | 'unavailable' | 'not_applicable'
  evidence: Evidence[]
  detail: string
  remote?: boolean
  resolved?: boolean
}
export interface LiveIssue extends JiraIssue {
  remote: boolean
}
export function assignedToOwner(profile: Profile, issue: LiveIssue) {
  return !!profile.jira_owner && issue.assignee_account_id === profile.jira_owner
}
type Query = Parameters<JiraTaskReader>[0]
interface ProjectScope {
  key: string | null
  site: string | null
  company: string | undefined
  title: string
  private: boolean
}
const keyPattern = /\b[A-Z][A-Z0-9_]{0,19}-\d{1,9}\b/gi
const keyOf = (text: unknown) =>
  String(text ?? '')
    .match(keyPattern)?.[0]
    ?.toUpperCase()
const issueKeys = (text: string) => [...new Set((text.match(keyPattern) ?? []).map((key) => key.toUpperCase()))].slice(0, 30)
const words = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.join(' ') ?? ''
const includesPhrase = (text: string, phrase: string) => (' ' + words(text) + ' ').includes(' ' + words(phrase) + ' ')

/** SQL parameters and aliases are supplied by the module, never by the user. */
export const recentJira = (now: string, alias = 'c') => `coalesce(${alias}.source->>'jira_verification','')='verified' AND EXISTS(
  SELECT 1 FROM assistant_source_cursors j JOIN entities p ON p.id=j.project_id
  JOIN assistant_profiles profile ON profile.project_id=j.project_id
  WHERE j.project_id=${alias}.project_id AND j.source_key='jira/verified'
  AND (profile.config->>'jira_assignee_scope'='project' OR nullif(profile.config->>'jira_owner','')=${alias}.source->>'assignee_account_id')
  AND (${alias}.source->>'jira_scope_key' IS NULL OR (p.data->>'jira_project_key'=${alias}.source->>'jira_scope_key'
    AND coalesce(nullif(p.data->>'jira_site_url',''),(SELECT value->>'default_site_url' FROM settings WHERE key='jira'),
      ${alias}.source->>'jira_scope_site')=${alias}.source->>'jira_scope_site'))
  AND (julianday(${now})-julianday(j.scanned_at))*1440 BETWEEN 0 AND 15)`

export function presentCase(row: CaseRow & { current_source: number }): CaseRow {
  const { current_source, ...item } = row
  if (item.kind !== 'jira' || item.state !== 'open' || current_source) return item
  const { url, issue_key, task_id, remote } = item.source
  return {
    ...item,
    score: 0,
    draft: null,
    evidence: [],
    source: { url, issue_key, task_id, remote, jira_verification: 'unavailable' },
    reason: item.source.jira_verification === 'unavailable' ? item.reason : 'Pendiente de confirmar el estado actual en Jira.',
  }
}

export function caseIssueKey(row: JiraCase) {
  const url = String(row.source.url ?? '').match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)\b/i)?.[1]
  return keyOf(row.source.issue_key) ?? keyOf(url) ?? keyOf(row.title)
}

export function issueEvidence(issue: LiveIssue): Evidence {
  const details = [
    'Estado en Jira: ' + issue.status,
    issue.assignee && 'Asignación: ' + issue.assignee,
    issue.due_at && 'Vencimiento: ' + issue.due_at,
    issue.priority && 'Prioridad: ' + issue.priority,
    issue.updated && 'Actualización: ' + issue.updated,
    issue.description?.slice(0, 1400),
  ]
  return {
    id: 'jira/' + issue.site + '/' + issue.key,
    title: issue.key + ' · ' + issue.summary,
    text: details.filter(Boolean).join('\n'),
    at: issue.updated ?? '',
    url: issue.site + '/browse/' + issue.key,
    remote: issue.remote,
  }
}

export class AssistantJira {
  constructor(
    readonly db: Sql,
    readonly enabled: ModuleEnabled,
    readonly reader?: JiraTaskReader,
  ) {}
  private async scope(project: string): Promise<ProjectScope> {
    const [p] = await this.db.query(
      `SELECT p.title,p.data,c.title AS company,c.data->>'remote_processing' AS company_remote
      FROM entities p LEFT JOIN entities c ON c.id=p.data->>'company_id' AND c.kind='company'
      WHERE p.kind='project' AND p.id=$1`,
      [project],
    )
    check(p, 'Proyecto inexistente', 404)
    return {
      key: (p.data.jira_project_key as string) || null,
      site: await effectiveJiraSite(this.db, p.data.jira_site_url),
      company: [p.company, p.data.empresa, p.data.cliente].find((v): v is string => typeof v === 'string' && !!v.trim()),
      title: String(p.title),
      private: [p.data.remote_processing, p.company_remote].some((value) => [false, 0, 'false'].includes(value)),
    }
  }
  private async privacy(project: string, site: string | null, keys: string[], local: boolean) {
    const [restrictedSite] = await this.db.query(
      `SELECT 1 FROM connectors c WHERE c.provider='jira'
      AND ($2 IS NULL OR rtrim(c.config->>'site_url','/')=$2)
      AND (json_array_length(c.project_ids)=0 OR EXISTS(SELECT 1 FROM json_each(c.project_ids) WHERE value=$1))
      AND c.config->>'remote_processing' IN (0,'false') LIMIT 1`,
      [project, site],
    )
    const sources = keys.length
      ? await this.db.query(
          `SELECT DISTINCT e.data->>'key' AS key FROM entities e
      LEFT JOIN sources s ON s.entity_id=e.id LEFT JOIN connectors c ON c.id=s.connector_id
      WHERE e.kind='issue' AND e.data->>'key' IN (SELECT value FROM json_each($3))
      AND ((s.url=$2||'/browse/'||(e.data->>'key')) OR (EXISTS(SELECT 1 FROM links l WHERE l.from_id=e.id AND l.type='project' AND l.to_id=$1)
        AND ($2 IS NULL OR coalesce(rtrim(c.config->>'site_url','/'),$2)=$2)))
      AND (e.data->>'remote_processing' IN (0,'false') OR c.config->>'remote_processing' IN (0,'false') OR EXISTS(
        SELECT 1 FROM links l JOIN entities p ON p.id=l.to_id WHERE l.from_id=e.id AND l.type='project' AND p.data->>'remote_processing' IN (0,'false')))`,
          [project, site, keys],
        )
      : []
    return { remote: !local && !restrictedSite, privateKeys: new Set(sources.map((row) => String(row.key))) }
  }
  private async read(project: string, query: Query, scope: ProjectScope, signal: AbortSignal) {
    const available = () => this.enabled('assistants') && this.enabled('memory') && this.enabled('connections') && this.enabled('mcp')
    signal.throwIfAborted()
    check(available(), 'La lectura de Jira por MCP está desactivada', 409)
    check(this.reader, 'Falta la conexión de lectura de Jira por MCP', 409)
    const issues = new Map<string, JiraIssue>()
    let origin: string | undefined
    await this.reader({ ...query, signal }, async (page, site) => {
      signal.throwIfAborted()
      check(available(), 'La lectura de Jira por MCP está desactivada', 409)
      const normalizedSite = jiraSiteUrl.safeParse(site)
      check(
        normalizedSite.success && (!query.site || query.site === normalizedSite.data) && (!origin || origin === normalizedSite.data),
        'El MCP devolvió otro sitio Jira',
        502,
      )
      origin = normalizedSite.data
      for (const raw of page) {
        const item = normalizeJiraIssue(raw, origin)
        check(item, 'El MCP devolvió un ticket de Jira incompleto', 502)
        if (query.key) check(item.key.split('-')[0] === query.key, 'Jira devolvió tickets de otro proyecto', 502)
        if (query.issueKeys?.length && !query.issueKeys.includes(item.key)) continue
        const jiraProject = (raw as { fields?: { project?: { key?: string } } }).fields?.project?.key
        check(!jiraProject || item.key.split('-')[0] === jiraProject, 'Jira devolvió una clave de otro proyecto', 502)
        check(!issues.has(item.key), 'Jira repitió un ticket entre los resultados de la consulta', 502)
        issues.set(item.key, { ...item, url: origin + '/browse/' + item.key })
      }
    })
    signal.throwIfAborted()
    check(origin && available(), 'No se pudo confirmar la lectura del proyecto en Jira', 502)
    const current = await this.scope(project)
    check(
      current.key === scope.key && current.site === scope.site && current.company === scope.company,
      'El sitio, la clave o la empresa vinculada al proyecto cambió durante la consulta a Jira',
      409,
    )
    // A company search can match tickets managed for other Hub projects on this Jira site.
    const reserved = query.key
      ? []
      : await this.db.query(
          `SELECT data->>'jira_project_key' AS key FROM entities
      WHERE kind='project' AND id<>$1 AND data->>'jira_project_key' IS NOT NULL AND data->>'merged_into' IS NULL
      AND coalesce(nullif(data->>'jira_site_url',''),(SELECT value->>'default_site_url' FROM settings WHERE key='jira'),$2)=$2`,
          [project, origin],
        )
    const otherKeys = new Set(reserved.map((row) => row.key))
    const matches = [...issues.values()].filter(
      (issue) =>
        !otherKeys.has(issue.key.split('-')[0]) &&
        (!query.company || includesPhrase(issue.summary + ' ' + (issue.description ?? ''), query.company)),
    )
    const keys = [...new Set([...(query.issueKeys ?? []), ...matches.map((issue) => issue.key)])]
    const { remote, privateKeys } = await this.privacy(project, origin, keys, scope.private || current.private)
    return {
      remote: remote && !(query.issueKeys ?? []).some((key) => privateKeys.has(key)),
      outsideProject: (query.issueKeys ?? []).some((key) => otherKeys.has(key.split('-')[0])),
      issues: matches.map((issue) => ({ ...issue, remote: remote && !privateKeys.has(issue.key) })),
    }
  }

  /** Only a complete, project-wide read can retire an alert for a ticket that disappeared. */
  async projectIssues(project: string, signal: AbortSignal): Promise<LiveIssue[] | null> {
    const scope = await this.scope(project)
    if (!scope.key) return null
    return (await this.read(project, { key: scope.key, site: scope.site }, scope, signal)).issues
  }

  async evidence(project: string, row: JiraCase | null, question: string, signal: AbortSignal): Promise<LiveEvidence> {
    let privacyScope: { site: string | null; local: boolean } | undefined
    let remote: boolean | undefined
    const empty = (status: LiveEvidence['status'], detail: string): LiveEvidence => ({
      status,
      detail,
      evidence: [],
      ...(remote !== undefined ? { remote } : status === 'unavailable' ? { remote: false } : {}),
    })
    const focused = row?.kind === 'jira'
    const text = [row?.title, row?.source.text, question].filter(Boolean).join('\n')
    let keys = focused ? [] : issueKeys(text)
    if (!focused && row?.kind !== 'slack' && !keys.length && !/\b(jira|tickets?|issues?|tareas?|backlog)\b/i.test(question))
      return empty('not_applicable', '')
    try {
      const scope = await this.scope(project)
      let site = scope.site
      privacyScope = { site, local: scope.private }
      if (focused) {
        let key = caseIssueKey(row)
        const caseSite = jiraSiteUrl.safeParse(row.source.url)
        if (caseSite.success) {
          if (site && caseSite.data !== site)
            return empty('unavailable', 'El sitio de este asunto es distinto del sitio actual del proyecto.')
          site ??= caseSite.data
        }
        if (!key) {
          const [task] = await this.db.query("SELECT external_key,external_site FROM tasks WHERE project_id=$1 AND kind='jira' AND id=$2", [
            project,
            row.source.task_id ?? row.source_key.slice('jira/'.length),
          ])
          if (site && task?.external_site && task.external_site !== site) return empty('unavailable', 'El sitio del ticket cambió.')
          key = keyOf(task?.external_key)
          site ??= task?.external_site || null
        }
        if (!key) return empty('unavailable', 'El asunto guardado no identifica un ticket que se pueda consultar en Jira.')
        keys = [key]
      }
      if (scope.key && keys.some((key) => key.split('-')[0] !== scope.key)) {
        keys = keys.filter((key) => key.split('-')[0] === scope.key)
        if (!keys.length) return empty('unavailable', 'La clave del ticket pertenece a otro proyecto de Jira.')
      }
      // Without a Jira project, use the associated company, an explicitly named prospect or the project title mentioned in Slack.
      const prospect =
        /\b(?:cliente(?: potencial)?|empresa|prospecto|company|client)\s*[:=]?\s+[«“"]([^»”"\n]{2,100})[»”"]/iu.exec(text)?.[1] ??
        /\b(?:[Cc]liente(?: potencial)?|[Ee]mpresa|[Pp]rospecto|[Cc]ompany|[Cc]lient)\s*[:=]?\s+(\p{Lu}[\p{L}\d.-]*(?:\s+\p{Lu}[\p{L}\d.-]*){0,3})/u.exec(
          text,
        )?.[1]
      const namedClient = prospect?.trim().replace(/[.-]+$/, '')
      const clientInProject = namedClient && ![scope.company, scope.title].some((name) => name && words(name) === words(namedClient))
      const channel = row?.kind === 'slack' ? String(row.source.channel_name ?? '') : ''
      const clientChannel = /^(?:ext|cliente|client|empresa|prospecto|prospect)-(.+)$/i.exec(channel)?.[1]
      const projectNamed = includesPhrase(text, scope.title) || words(channel) === words(scope.title)
      const company =
        !focused &&
        (!scope.key
          ? namedClient || scope.company || clientChannel || (projectNamed ? scope.title : undefined)
          : !keys.length && clientInProject
            ? namedClient
            : undefined)
      if (!scope.key && !keys.length && !company)
        return empty('not_applicable', 'El proyecto no tiene una clave de Jira ni una empresa identificada para esta consulta.')
      privacyScope.site = site
      const result = await this.read(
        project,
        {
          key: scope.key,
          site,
          ...(keys.length ? { issueKeys: keys } : {}),
          ...(company ? { company } : {}),
        },
        scope,
        signal,
      )
      remote = result.remote
      const items = result.issues
      const missing = keys.filter((key) => !items.some((issue) => issue.key === key))
      if (result.outsideProject && !items.length)
        return empty('not_applicable', 'La clave consultada está vinculada a otro proyecto del Hub en este sitio de Jira.')
      if (missing.length && !items.length)
        return empty(
          'not_visible',
          missing.join(', ') +
            ' no figura en la consulta de Jira para ' +
            (company ? 'la empresa ' + company : 'este proyecto') +
            ' con esta cuenta. Puede faltar acceso o el ticket puede haber cambiado de proyecto o haberse eliminado.',
        )
      const queryTerms = terms(question).map(words)
      const overview = /\b(?:backlog|tickets|tareas|issues)\b/i.test(question) && !keys.length
      const ranked = items
        .map((issue) => {
          const contents = ' ' + words(issue.summary + ' ' + (issue.description ?? '')) + ' '
          return { issue, rank: queryTerms.filter((term) => contents.includes(' ' + term + ' ')).length }
        })
        .filter(
          ({ issue, rank }) =>
            keys.length || company || rank || (overview && !['done', 'dropped'].includes(mapJiraStatus(issue.status, issue.category))),
        )
      const evidence = ranked
        .sort(
          (a, b) =>
            b.rank - a.rank || (b.issue.updated ?? '').localeCompare(a.issue.updated ?? '') || a.issue.key.localeCompare(b.issue.key),
        )
        .slice(0, 8)
        .map(({ issue }) => issueEvidence(issue))
      const detail = missing.length
        ? 'Jira no mostró ' + missing.join(', ') + ' para esta cuenta.'
        : evidence.length
          ? 'Estados consultados directamente en Jira por MCP.'
          : 'Jira no devolvió tickets relacionados en el alcance consultado.'
      const exact = focused && items.length === 1 ? items[0] : undefined
      return {
        status: 'verified',
        evidence,
        detail,
        remote: remote && evidence.every((e) => e.remote),
        ...(exact ? { resolved: ['done', 'dropped'].includes(mapJiraStatus(exact.status, exact.category)) } : {}),
      }
    } catch (error) {
      signal.throwIfAborted()
      if (privacyScope) {
        const privacy = await this.privacy(project, privacyScope.site, keys, privacyScope.local)
        remote = privacy.remote && !keys.some((key) => privacy.privateKeys.has(key))
      } else remote = false
      return empty(
        'unavailable',
        'No se pudo verificar Jira por MCP. ' + (error instanceof Error ? error.message.slice(0, 260) : 'Error de lectura.'),
      )
    }
  }
}
