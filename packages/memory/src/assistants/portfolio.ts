import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { portfolioPolicy, profile, watch, type Profile, type Watch } from './contracts.js'
import type { Sql } from '../database.js'

export async function readPolicy(sql: Sql) {
  const [row] = await sql.query('SELECT value FROM assistant_portfolio_policy WHERE singleton=1')
  return { version: Number(row?.value?.version ?? 0), config: portfolioPolicy.parse(row?.value?.config ?? {}) }
}

export async function enroll(sql: Sql, project?: string) {
  const { notifications: _notifications, notion_contracts: _contracts, ...defaults } = (await readPolicy(sql)).config
  const base = profile.parse({ ...defaults, active: true })
  await sql.query(
    `INSERT INTO assistant_profiles(project_id,config,version)
    SELECT id,$1,0 FROM entities WHERE kind='project' AND coalesce(data->>'memory_state','')<>'archived' AND id NOT IN (SELECT project_id FROM archived_projects)
    AND ($2 IS NULL OR id=$2) AND NOT EXISTS(SELECT 1 FROM assistant_profiles p WHERE p.project_id=entities.id)
    ON CONFLICT(project_id) DO NOTHING`,
    [base, project ?? null],
  )
}

export interface Identities {
  slack(id: string): Promise<{ team: string; owner: string } | null>
  jira(): Promise<string | null>
  channelName?(id: string, channel: string): Promise<string | null>
  jiraFor?(id: string, site: string): Promise<string | null>
}
export type Bindings = Partial<Pick<Profile, 'slack' | 'github_repos' | 'jira_owner'>>
function github(value: unknown) {
  if (typeof value !== 'string') return null
  const match = /^(?:(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/))?([\w-]+\/[\w.-]+?)\/?$/i.exec(value.trim())
  const slug = match?.[1]?.replace(/\.git$/i, '')
  return slug && !slug.split('/').some((p) => p === '.' || p === '..') ? slug : null
}
const runGit = promisify(execFile)
const folderOrigins = new Map<string, { slug: string | null; until: number }>()
async function registeredOrigin(folder: string) {
  const now = Date.now(),
    cached = folderOrigins.get(folder)
  if (cached && cached.until > now) return cached.slug
  let slug: string | null = null
  try {
    const marker = await stat(join(folder, '.git'))
    if (marker.isFile() || marker.isDirectory()) {
      const { stdout } = await runGit(
        'git',
        ['--no-optional-locks', '-C', folder, 'config', '--local', '--no-includes', '--get', 'remote.origin.url'],
        { timeout: 3000, maxBuffer: 8192 },
      )
      slug = github(stdout) ?? null
    }
  } catch {
    /* A missing checkout or origin contributes no GitHub repository. */
  }
  folderOrigins.set(folder, { slug, until: now + 300000 })
  return slug
}
function channelId(value: unknown) {
  if (typeof value !== 'string') return null
  return (
    /^([CG][A-Z0-9]{2,30})$/.exec(value)?.[1] ??
    /^https:\/\/(?:[\w-]+\.)?slack\.com\/(?:archives\/|client\/T[A-Z0-9]+\/)([CG][A-Z0-9]{2,30})(?:[/?#]|$)/.exec(value)?.[1]
  )
}

type Project = { id: string; title: string; data: Record<string, unknown> }
function slug(value: unknown) {
  return typeof value === 'string'
    ? value
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    : ''
}
function ownerOfChannel(projects: Project[], assigned: string[], channel: string, links: string[], name?: string | null) {
  const eligible = projects.filter((p) => !assigned.length || assigned.includes(p.id))
  if (assigned.length === 1) return eligible[0]?.id
  const pinned = eligible.filter((p) => [p.data.slack_channel_id, p.data.slack_channel, p.data.canal].some((v) => channelId(v) === channel))
  if (pinned.length) return pinned.length === 1 ? pinned[0]!.id : undefined
  const linked = eligible.filter((p) => links.includes(p.id))
  if (linked.length) return linked.length === 1 ? linked[0]!.id : undefined
  const key = slug(name).replace(/^(?:ext|cliente|client|proyecto|project|shared|connect)-/, '')
  if (key.length < 3) return
  const matches = eligible.filter((p) => [p.title, p.data.cliente, p.data.empresa].some((v) => slug(v) === key))
  return matches.length === 1 ? matches[0]!.id : undefined
}
async function linkedChannels(db: Sql) {
  return db.query(`SELECT DISTINCT s.connector_id,e.data->>'channel' AS channel,l.to_id AS project FROM sources s JOIN entities e ON e.id=s.entity_id
    JOIN links l ON l.from_id=e.id AND l.type='project' WHERE s.provider='slack' AND s.status='active' AND e.data->>'channel' IS NOT NULL`)
}
export async function channelWithinProject(db: Sql, project: string, id: string, channel: string, readName?: () => Promise<string | null>) {
  const [c] = await db.query("SELECT config,project_ids FROM connectors WHERE id=$1 AND enabled AND provider='slack'", [id])
  if (!c || !c.config.channel_ids?.includes(channel)) return false
  const projectRows = await db.query<Project>(
    "SELECT id,title,data FROM entities WHERE kind='project' AND coalesce(data->>'memory_state','')<>'archived' AND id NOT IN (SELECT project_id FROM archived_projects)",
  )
  if (c.project_ids.length && c.project_ids.includes(project) && projectRows.some((p) => p.id === project)) return true
  if (c.project_ids.length) return false
  const links = (await linkedChannels(db)).filter((l) => l.connector_id === id && l.channel === channel).map((l) => l.project)
  const resolve = (name?: string | null) => ownerOfChannel(projectRows, [], channel, links, name)
  return (resolve() ?? resolve(await readName?.())) === project
}

export async function discoverBindings(db: Sql, identities: Identities, connections: boolean) {
  const projects =
    await db.query(`SELECT e.id,e.title,e.data,p.config,p.source_overrides,p.version FROM assistant_profiles p JOIN entities e
    ON e.id=p.project_id WHERE coalesce(e.data->>'memory_state','')<>'archived' AND e.id NOT IN (SELECT project_id FROM archived_projects) ORDER BY e.id`)
  const repositories = await db.query('SELECT project_id,canonical_remote_url FROM project_repositories ORDER BY project_id,id')
  const connectors = connections
    ? await db.query("SELECT id,config,project_ids FROM connectors WHERE enabled AND provider='slack' ORDER BY id")
    : []
  const links = connectors.length ? await linkedChannels(db) : []
  const jira =
    connections && projects.some((p) => p.config.active && !p.source_overrides?.jira_owner)
      ? await identities.jira().catch(() => null)
      : null
  const jiraAccounts = new Map<string, Set<string>>()
  if (connections && !jira && identities.jiraFor) {
    const sources = await db.query("SELECT id,config,project_ids FROM connectors WHERE enabled AND provider='jira'")
    for (const c of sources) {
      const id = await identities.jiraFor(c.id, String(c.config.site_url ?? '')).catch(() => null)
      if (!id) continue
      for (const p of projects) {
        if (
          !c.project_ids.includes(p.id) &&
          (c.project_ids.length || String(p.data.jira_site_url ?? '').replace(/\/$/, '') !== String(c.config.site_url).replace(/\/$/, ''))
        )
          continue
        const ids = jiraAccounts.get(p.id) ?? new Set<string>()
        ids.add(id)
        jiraAccounts.set(p.id, ids)
      }
    }
  }
  const channels = new Map<string, { project: string; watch: Watch }[]>()
  const manual = new Set<string>()
  for (const p of projects) if (p.config.active) for (const w of p.source_overrides?.slack ?? []) manual.add(w.team + '/' + w.channel)
  for (const c of connectors) {
    const assigned = projects.filter((p) => !c.project_ids.length || c.project_ids.includes(p.id))
    if (!assigned.some((p) => p.config.active)) continue
    const who = await identities.slack(c.id).catch(() => null)
    if (!who) continue
    for (const channel of new Set<string>(c.config.channel_ids ?? [])) {
      const parsed = watch.safeParse({ connector_id: c.id, channel, ...who, colleagues: [] })
      if (!parsed.success) continue
      const key = who.team + '/' + channel
      if (manual.has(key)) continue
      const projectLinks = links.filter((l) => l.connector_id === c.id && l.channel === channel).map((l) => l.project)
      const candidates = assigned.map((p) => ({ id: p.id, title: p.title, data: p.data }))
      const match = (name?: string | null) => ownerOfChannel(candidates, c.project_ids, channel, projectLinks, name)
      const project = match() ?? match(await identities.channelName?.(c.id, channel).catch(() => null))
      if (!project || !assigned.find((p) => p.id === project)?.config.active) continue
      const list = channels.get(key) ?? []
      list.push({ project, watch: parsed.data })
      channels.set(key, list)
    }
  }
  const byProject = new Map<string, Watch[]>()
  for (const list of channels.values()) {
    if (new Set(list.map((w) => w.project)).size !== 1) continue
    const { project, watch } = list[0]!
    byProject.set(project, [...(byProject.get(project) ?? []), watch])
  }
  const origins = new Map<string, string | null>()
  const folders = (p: Record<string, any>): string[] =>
    Array.isArray(p.data.folders) ? p.data.folders.filter((f: unknown): f is string => typeof f === 'string' && isAbsolute(f)) : []
  if (connections) {
    const registered = new Set(projects.filter((p) => p.config.active).flatMap(folders))
    for (const cached of folderOrigins.keys()) if (!registered.has(cached)) folderOrigins.delete(cached)
    for (const folder of registered) origins.set(folder, await registeredOrigin(folder))
  }
  return projects.map((p) => {
    const manual: Bindings = p.source_overrides ?? {}
    const urls = [
      ...repositories.filter((r) => r.project_id === p.id).map((r) => r.canonical_remote_url),
      ...folders(p).map((f) => origins.get(f)),
      ...(!connections ? (p.config.github_repos ?? []) : []),
      p.data.repo_url,
      p.data.repository,
      p.data.repo,
    ]
    const repos = [...new Set([...(manual.github_repos ?? []), ...urls.map(github).filter((s): s is string => !!s)])].slice(0, 12)
    const slack = [...(manual.slack ?? []), ...(byProject.get(p.id) ?? [])].slice(0, 30)
    return {
      id: String(p.id),
      version: Number(p.version),
      previous: profile.parse(p.config),
      bindings: {
        slack,
        github_repos: repos,
        jira_owner: manual.jira_owner || jira || (jiraAccounts.get(p.id)?.size === 1 ? [...jiraAccounts.get(p.id)!][0] : '') || '',
      },
    }
  })
}
