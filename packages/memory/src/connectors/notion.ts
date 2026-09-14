import type { Connector, ConnectorContext } from './types.js'
import { richText, ProviderError } from './http.js'
import { check, MemoryError, type ImportInput } from '../contracts.js'

export async function syncNotion(connector: Connector, ctx: ConnectorContext): Promise<void> {
  const credentials = ctx.vault.read(connector.id)
  check(credentials?.token, 'Configurá el token de la integración de Notion', 409)
  const headers = { Authorization: `Bearer ${credentials.token}`, 'Notion-Version': '2025-09-03' }
  const ids = new Set<string>(connector.config.page_ids ?? [])
  if (!ids.size) {
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await ctx.http.json('https://api.notion.com/v1/search', headers, { filter: { value: 'page', property: 'object' }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) })
      for (const item of page.results ?? []) ids.add(item.id)
      cursor = page.has_more ? page.next_cursor : undefined
      if (cursor && seen.has(cursor)) throw new MemoryError(502, 'Notion repitió un cursor')
      if (cursor) seen.add(cursor)
    } while (cursor)
  }
  let imported = 0, inaccessible = 0
  for (const pageId of ids) {
    ctx.signal.throwIfAborted()
    try {
      const page = await ctx.http.json(`https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`, headers)
      if (page.in_trash || page.archived) {
        await ctx.store.db.query("UPDATE sources SET status='deleted' WHERE provider='notion' AND account=$1 AND external_id=$2", [connector.id, pageId])
        continue
      }
      const fragments: ImportInput['fragments'] = [], originals: any[] = [], visited = new Set<string>()
      async function children(blockId: string, depth: number): Promise<void> {
        check(depth < 100 && !visited.has(blockId), 'Jerarquía de Notion circular o demasiado profunda')
        visited.add(blockId)
        let cursor: string | undefined
        const cursors = new Set<string>()
        do {
          const url = new URL(`https://api.notion.com/v1/blocks/${encodeURIComponent(blockId)}/children`)
          url.searchParams.set('page_size', '100'); if (cursor) url.searchParams.set('start_cursor', cursor)
          const batch = await ctx.http.json(url.toString(), headers)
          for (const block of batch.results ?? []) {
            originals.push(block)
            const content = block[block.type] ?? {}
            const text = (content.cells ? content.cells.map((cell: any[]) => richText(cell)).join(' | ') : richText(content.rich_text ?? content.caption ?? [])) || (content.title ?? content.url ?? '')
            if (text) fragments.push({ text: String(text), external_id: block.id, metadata: { block_type: block.type, depth } })
            if (block.type === 'child_page') ids.add(block.id)
            if (block.has_children) await children(block.id, depth + 1)
          }
          cursor = batch.has_more ? batch.next_cursor : undefined
          check(!cursor || !cursors.has(cursor), 'Notion repitió un cursor')
          if (cursor) cursors.add(cursor)
        } while (cursor)
      }
      await children(pageId, 0)
      const title = Object.values(page.properties ?? {}).filter((p: any) => p.type === 'title').map((p: any) => richText(p.title)).join('') || 'Página de Notion'
      await ctx.store.ingest({ provider: 'notion', account: connector.id, connector_id: connector.id, external_id: pageId, kind: 'document', title,
        ...(page.url ? { url: page.url } : {}), text: title, fragments: fragments.length ? fragments : [{ text: title, metadata: {} }],
        project_ids: connector.project_ids, metadata: { modified_at: page.last_edited_time, properties: page.properties, parent: page.parent }, original: { page, blocks: originals } }, 'connector:notion')
      imported++
    } catch (error) {
      if (!(error instanceof ProviderError && [403, 404].includes(error.httpStatus))) throw error
      await ctx.store.db.query("UPDATE sources SET status='inaccessible' WHERE provider='notion' AND account=$1 AND external_id=$2", [connector.id, pageId])
      inaccessible++
    }
    await ctx.progress({ imported, inaccessible, discovered: ids.size })
  }
  if (inaccessible) throw new MemoryError(409, `Se importaron ${imported} páginas; ${inaccessible} requieren revisar acceso en Notion`)
}
