import { z } from 'zod'
import { check, parse } from './contracts.js'
import type { MemoryDatabase, Sql } from './database.js'

export const jiraSiteUrl = z.string().trim().url().refine(value => {
  try { const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.endsWith('.atlassian.net') && !url.username && !url.password && !url.port
  } catch { return false }
}, 'Se requiere un sitio de Jira Cloud (https://empresa.atlassian.net)').transform(value => new URL(value).origin)
export const jiraSettingsInput = z.object({ default_site_url: z.union([z.literal(''),jiraSiteUrl]).nullable().transform(value => value || null) }).strict()

export async function getJiraSettings(sql: Sql): Promise<{ default_site_url: string|null }> {
  return { default_site_url: (await sql.query("SELECT value->>'default_site_url' AS site FROM settings WHERE key='jira'"))[0]?.site || null }
}
export async function effectiveJiraSite(sql: Sql, projectSite: unknown): Promise<string|null> {
  return typeof projectSite === 'string' && projectSite ? projectSite : (await getJiraSettings(sql)).default_site_url
}
export async function saveJiraSettings(db: MemoryDatabase, raw: unknown) {
  const settings = parse(jiraSettingsInput,raw)
  return db.transaction(async sql => {
    // Shared with project configuration: default changes cannot introduce duplicate ownership.
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('jira-sites',0))")
    const projects = await sql.query(`SELECT title,data->>'jira_project_key' AS key,
      COALESCE(NULLIF(data->>'jira_site_url',''),$1::text) AS site FROM entities
      WHERE kind='project' AND COALESCE(data->>'jira_project_key','')<>''`,[settings.default_site_url])
    const seen = new Map<string,typeof projects>()
    for (const project of projects) {
      const previous = seen.get(project.key) ?? []
      const conflict = previous.find(p => !p.site || !project.site || p.site === project.site)
      check(!conflict, `El sitio predeterminado haría que «${conflict?.title}» y «${project.title}» compartan la clave ${project.key}. Configura un sitio propio en uno de esos proyectos.`,409)
      seen.set(project.key,[...previous,project])
    }
    await sql.query("INSERT INTO settings(key,value) VALUES('jira',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify(settings)])
    return settings
  })
}
