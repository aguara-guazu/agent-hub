import { notionId, type NotionContractSettings, type ProjectContract } from './contracts.js'
import { check } from '../contracts.js'

export type NotionRead = (tool: 'fetch' | 'query', args: Record<string, unknown>, signal: AbortSignal) => Promise<any>
export interface NotionContractRow extends ProjectContract {
  projects: { id: string | null; name: string }[]
}
interface Column {
  name: string
  type: string
  dataSourceUrl?: string
}
interface Source {
  url: string
  columns: Column[]
  view: string | undefined
}

type Row = Record<string, unknown>
type Fields = Record<string, string | null>

const quoted = (s: string) => '"' + s.replaceAll('"', '""') + '"'
const marks = (items: unknown[]) => items.map(() => '?').join(',')
const normalized = (value: string) => value.trim().toLocaleLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
const idColumn = (column: string) => `substr(replace(lower(${column}),'-',''),-32)`
const flatId = (id: string) => id.replaceAll('-', '')

function completeTable(document: string, collection: string) {
  for (const [, url, body] of document.matchAll(/<view url="\{*(view:\/\/[a-f\d-]+)\}*">\s*([\s\S]*?)\s*<\/view>/gi)) {
    const v = JSON.parse(body!)
    if (
      String(v.dataSourceUrl).replace(/[{}]/g, '') === collection &&
      v.type === 'table' &&
      !v.groupBy &&
      !v.advancedFilter &&
      !v.simpleFilters?.length &&
      !v.filter &&
      !v.filters?.length
    )
      return url
  }
}

async function source(read: NotionRead, ref: string, signal: AbortSignal): Promise<Source> {
  const result = await read('fetch', { id: ref }, signal)
  const sources = [
    ...String(result?.text ?? '').matchAll(/<data-source url="\{*(collection:\/\/[a-f\d-]+)\}*">([\s\S]*?)<\/data-source>/gi),
  ]
  check(sources.length === 1, 'Notion requiere una base con una sola fuente o el enlace collection:// de la fuente de contratos', 422)
  const [, url, body] = sources[0]!
  const state = body!.match(/<data-source-state>\s*([\s\S]*?)\s*<\/data-source-state>/)?.[1]
  check(notionId(url!) && state, 'No se pudo leer el esquema de la base de Notion', 502)
  const columns: Column[] = Object.entries(JSON.parse(state!).schema ?? {}).map(([name, raw]) => ({ ...(raw as Column), name }))
  check(columns.length, 'Notion no devolvió las propiedades de la base', 502)
  let view = completeTable(String(result.text), url!)
  if (!view && result.metadata?.type === 'data_source' && notionId(result.url ?? '') && notionId(result.url) !== notionId(url!)) {
    try {
      const database = await read('fetch', { id: result.url }, signal)
      view = completeTable(String(database?.text ?? ''), url!)
    } catch {
      // A shared data source can be readable even when its parent database is private.
      signal.throwIfAborted()
    }
  }
  return { url: url!, columns, view }
}

function column(s: Source, names: string[], types: string[], optional = false) {
  const found = names.length
    ? names.map((n) => s.columns.find((c) => normalized(c.name) === normalized(n) && types.includes(c.type))).find(Boolean)
    : s.columns.find((c) => types.includes(c.type))
  check(found || optional, 'Falta la propiedad de Notion «' + (names[0] || types[0]) + '»', 422)
  return found
}

/** Notion can return fewer rows than the SQL LIMIT on the current plan. Advance by rows actually read. */
async function rows(
  read: NotionRead,
  s: Source,
  fields: Fields,
  where: string,
  params: string[],
  signal: AbortSignal,
  include: (row: Row) => boolean = () => true,
) {
  const all: Row[] = [],
    seen = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  const select = Object.entries(fields)
    .map(([alias, name]) => (name ? quoted(name) : 'NULL') + ' AS ' + quoted(alias))
    .join(', ')
  for (;;) {
    signal.throwIfAborted()
    const query = `SELECT url, ${select} FROM ${quoted(s.url)} WHERE ${where} ORDER BY url LIMIT 50 OFFSET ${seen.size}`
    const data = s.view
      ? { mode: 'view', view_url: s.view, ...(cursor ? { start_cursor: cursor } : {}) }
      : { mode: 'sql', data_source_urls: [s.url], query, params }
    const page = await read('query', { data }, signal)
    check(
      Array.isArray(page?.results) && typeof page.has_more === 'boolean',
      'Notion no confirmó una lectura completa de contratos',
      502,
    )
    for (const row of page.results) {
      const id = notionId(String(row?.url ?? ''))
      check(id && !seen.has(id), 'Notion devolvió filas de contratos incompletas o repetidas', 502)
      seen.add(id!)
      if (s.view) {
        const selected = {
          url: row.url,
          ...Object.fromEntries(Object.entries(fields).map(([alias, name]) => [alias, name ? row[name] : null])),
        }
        if (include(selected)) all.push(selected)
      } else all.push(row)
    }
    if (!page.has_more && (s.view || page.results.length < 50)) return all
    check(page.results.length > 0 && seen.size <= 20000, 'No se pudo completar la paginación de Notion', 502)
    if (s.view) {
      check(
        typeof page.next_cursor === 'string' && !!page.next_cursor && !cursors.has(page.next_cursor),
        'Notion no confirmó la página siguiente de la vista',
        502,
      )
      cursor = page.next_cursor
      cursors.add(page.next_cursor)
    }
  }
}

function list(value: unknown): string[] {
  if (typeof value === 'string' && value.trim().startsWith('[')) value = JSON.parse(value)
  return (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && !!v.trim())
}

function day(value: unknown) {
  if (value == null || value === '') return null
  const date = String(value).slice(0, 10)
  check(
    /^\d{4}-\d\d-\d\d$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().startsWith(date),
    'Notion devolvió una fecha contractual inválida',
    502,
  )
  return date
}

export async function readNotionContracts(
  read: NotionRead,
  settings: NotionContractSettings,
  signal: AbortSignal,
): Promise<NotionContractRow[]> {
  const s = await source(read, settings.database, signal)
  const area = column(
    s,
    settings.area_property ? [settings.area_property] : ['Área', 'Area', 'Departamento', 'Department', 'Tipo', 'Service'],
    ['relation', 'select', 'multi_select', 'text'],
  )!
  const project = column(s, ['Proyecto', 'Project', 'Cliente', 'Client', 'Empresa', 'Company'], ['relation', 'text', 'select'])!
  const title = column(s, [], ['title'])!.name
  const selection = new Map(settings.areas.map((name) => [normalized(name), name]))
  const relationNames = new Map<string, string>()
  let filter: string, params: string[]
  const areaCol = quoted(area.name)
  if (area.type === 'relation') {
    check(area.dataSourceUrl, 'Notion no indicó la base relacionada con el área', 502)
    const types = await source(read, area.dataSourceUrl!, signal)
    const available = await rows(read, types, { name: column(types, [], ['title'])!.name }, '1=1', [], signal)
    for (const a of available) {
      const name = String(a.name ?? '')
      if (selection.has(normalized(name))) relationNames.set(notionId(String(a.url))!, name)
    }
    check(
      new Set([...relationNames.values()].map(normalized)).size === selection.size,
      'Notion no encontró todas las áreas elegidas en la relación ' + area.name,
      422,
    )
    params = [...relationNames.keys()].map(flatId)
    filter = `EXISTS (SELECT 1 FROM json_each(${areaCol}) area WHERE ${idColumn('area.value')} IN (${marks(params)}))`
  } else {
    params = settings.areas.map((a) => a.toLowerCase().trim())
    filter =
      area.type === 'multi_select'
        ? `EXISTS (SELECT 1 FROM json_each(${areaCol}) area WHERE lower(trim(area.value)) IN (${marks(params)}))`
        : `lower(trim(${areaCol})) IN (${marks(params)})`
  }
  const dateField = (names: string[], optional = false) => {
    const c = column(s, names, ['date'], optional)
    return c ? 'date:' + c.name + ':start' : null
  }
  const fields = {
    title,
    area: area.name,
    project: project.name,
    start: dateField(['Launch Date', 'Start Date', 'Fecha de inicio', 'Inicio', 'Start']),
    end: dateField(['End Date', 'Fecha de fin', 'Fin', 'Fecha de cierre', 'End']),
    extension: dateField(['Extension', 'Prórroga', 'Extended until'], true),
    closed: dateField(['Cierre', 'Actual close', 'Closed on', 'Cierre real'], true),
  }
  const areaName = (v: string) => (area.type === 'relation' ? relationNames.get(notionId(v) ?? '') : selection.get(normalized(v)))
  const contracts = await rows(read, s, fields, filter, params, signal, (row) => list(row.area).some((v) => !!areaName(v)))
  const projectNames = new Map<string, string>()
  if (project.type === 'relation' && contracts.length) {
    check(project.dataSourceUrl, 'Notion no indicó la base relacionada con el proyecto', 502)
    const ids = [
      ...new Set(
        contracts.flatMap((row) =>
          list(row.project)
            .map(notionId)
            .filter((id): id is string => !!id),
        ),
      ),
    ]
    if (s.view) {
      // A full client directory can exceed Notion’s mention limit. Only these pages are referenced by contracts of the selected areas.
      for (let i = 0; i < ids.length; i += 3) {
        await Promise.all(
          ids.slice(i, i + 3).map(async (id) => {
            const page = await read('fetch', { id }, signal)
            const parent = String(page?.text ?? '').match(/<parent-data-source url="\{*([^"}]+)\}*"/)?.[1]
            check(
              page?.metadata?.type === 'page' &&
                notionId(String(page.url)) === id &&
                parent === project.dataSourceUrl &&
                typeof page.title === 'string',
              'Notion no pudo confirmar la ficha del proyecto relacionado',
              502,
            )
            projectNames.set(id, page.title.trim())
          }),
        )
      }
    } else {
      const projects = await source(read, project.dataSourceUrl!, signal)
      const name = column(projects, [], ['title'])!.name
      for (let i = 0; i < ids.length; i += 40) {
        const group = ids.slice(i, i + 40).map(flatId)
        for (const row of await rows(
          read,
          { ...projects, view: undefined },
          { name },
          idColumn('url') + ' IN (' + marks(group) + ')',
          group,
          signal,
        ))
          projectNames.set(notionId(String(row.url))!, String(row.name ?? '').trim())
      }
    }
  }
  return contracts.map((row) => {
    const id = notionId(String(row.url))!
    const areas = list(row.area)
      .map(areaName)
      .filter((v): v is string => !!v)
    check(areas.length, 'Notion devolvió un contrato fuera del área consultada', 502)
    return {
      id,
      url: 'https://www.notion.so/' + flatId(id),
      title: String(row.title || 'Contrato'),
      areas: [...new Set(areas)].sort(),
      start: day(row.start),
      end: day(row.end),
      extension: day(row.extension),
      closed: day(row.closed),
      projects: list(row.project).map((v) =>
        project.type === 'relation' ? { id: notionId(v), name: projectNames.get(notionId(v) ?? '') ?? '' } : { id: null, name: v },
      ),
    }
  })
}
