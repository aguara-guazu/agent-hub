import { check, type ImportInput } from '../contracts.js'
import type { Connector, ConnectorContext } from './types.js'
import { richText } from './http.js'

export async function syncJira(connector: Connector, ctx: ConnectorContext): Promise<void> {
  const credentials = ctx.vault.read(connector.id)
  check(credentials?.email && credentials?.token, 'Configurá el email y token de Jira', 409)
  const site = new URL(connector.config.site_url ?? '')
  check(site.protocol === 'https:' && site.hostname.endsWith('.atlassian.net') && !site.username && !site.password, 'Usá la URL HTTPS de tu sitio de Jira Cloud')
  const headers = { Authorization: `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`, Accept: 'application/json' }
  const jql = String(connector.config.jql ?? '').trim()
  check(jql, 'Configurá el JQL que delimita las tareas a importar', 409)
  let next = '', imported = 0
  const seen = new Set<string>()
  do {
    ctx.signal.throwIfAborted()
    const page = await ctx.http.json(`${site.origin}/rest/api/3/search/jql`, headers, { jql, maxResults: 100,
      fields: ['summary', 'description', 'status', 'assignee', 'reporter', 'updated', 'created', 'duedate', 'project', 'issuelinks', 'labels'], ...(next ? { nextPageToken: next } : {}) })
    for (const issue of page.issues ?? []) {
      const fields = issue.fields ?? {}, comments: any[] = []
      let start = 0, total = 1
      while (start < total) {
        const batch = await ctx.http.json(`${site.origin}/rest/api/3/issue/${encodeURIComponent(issue.id)}/comment?startAt=${start}&maxResults=100`, headers)
        comments.push(...(batch.comments ?? [])); total = batch.total ?? comments.length
        check((batch.comments ?? []).length > 0 || start >= total, 'Jira devolvió una página de comentarios incompleta')
        start += (batch.comments ?? []).length
      }
      const participants: ImportInput['participants'] = []
      const fragments: ImportInput['fragments'] = [{ text: `${issue.key}: ${fields.summary}\n${richText(fields.description)}`.trim(), metadata: { section: 'description' } }]
      for (const comment of comments) {
        const author = comment.author
        if (author?.accountId && !participants.some(p => p.external_id === author.accountId)) participants.push({ external_id: author.accountId, name: author.displayName ?? author.accountId,
          ...(author.emailAddress ? { email: author.emailAddress } : {}), identity_verified: true })
        const text = richText(comment.body).trim()
        if (text) fragments.push({ text, external_id: comment.id, ...(author?.accountId ? { speaker: author.accountId } : {}),
          ...(comment.created ? { start_time: new Date(comment.created).toISOString() } : {}), metadata: { section: 'comment', updated: comment.updated ?? null } })
      }
      await ctx.store.ingest({ provider: 'jira', account: connector.id, connector_id: connector.id, external_id: issue.id,
        kind: 'issue', title: `${issue.key}: ${fields.summary}`, url: `${site.origin}/browse/${encodeURIComponent(issue.key)}`,
        ...(fields.updated ? { occurred_at: new Date(fields.updated).toISOString() } : {}), fragments, participants, project_ids: connector.project_ids,
        metadata: { key: issue.key, status: fields.status?.name ?? null, assignee: fields.assignee ?? null, due_date: fields.duedate ?? null, jira_project: fields.project ?? null,
          issue_links: fields.issuelinks ?? [], labels: fields.labels ?? [] }, original: { issue, comments } }, 'connector:jira')
      imported++
      await ctx.progress({ imported, coverage: 'Issues que coinciden con el JQL y todos sus comentarios accesibles' })
    }
    next = page.isLast ? '' : page.nextPageToken ?? ''
    check(!next || !seen.has(next), 'Jira repitió un cursor de búsqueda')
    seen.add(next)
  } while (next)
}
