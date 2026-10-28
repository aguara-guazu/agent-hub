import type { ReactNode } from 'react'

/** Tope de texto que se interpreta; el resto se descarta para que un artefacto enorme no congele la ventana. */
export const MARKDOWN_MAX_CHARS = 200_000
/** Más allá de este largo un párrafo se muestra como texto: el análisis de énfasis y enlaces es cuadrático en el peor caso. */
const MAX_INLINE_CHARS = 4_000
const MAX_DEPTH = 6
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** `null` salvo para http, https y mailto sin credenciales embebidas: nunca `javascript:`, `data:`, `file:` ni rutas relativas. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (!ALLOWED_PROTOCOLS.has(url.protocol) || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

const LINK = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/

/**
 * El texto nunca pasa por `innerHTML`: React escapa todo lo que no sea un elemento
 * construido aquí, así que el HTML crudo del markdown se muestra como texto. Las
 * imágenes no se cargan; se muestran como enlace para no descargar contenido remoto.
 */
function inline(text: string, depth = 0): ReactNode[] {
  if (text.length > MAX_INLINE_CHARS) return [text]
  const out: ReactNode[] = []
  let buffer = ''
  let key = 0
  const flush = (): void => { if (buffer) { out.push(buffer); buffer = '' } }
  const push = (node: ReactNode): void => { flush(); out.push(node) }
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i)
    let match: RegExpMatchArray | null
    if ((match = /^\\([\\`*_{}[\]()#+\-.!>|~])/.exec(rest))) { buffer += match[1]; i += match[0].length; continue }
    if ((match = /^`([^`]+)`/.exec(rest))) { push(<code key={key++}>{match[1]}</code>); i += match[0].length; continue }
    if ((match = IMAGE.exec(rest))) {
      const href = safeHref(match[2]!)
      const label = `Imagen: ${match[1] || 'sin descripción'}`
      push(href ? <a key={key++} href={href} target="_blank" rel="noopener noreferrer nofollow" title={href}>{label}</a> : <span key={key++}>{label}</span>)
      i += match[0].length; continue
    }
    if ((match = LINK.exec(rest))) {
      const href = safeHref(match[2]!)
      const label = depth < MAX_DEPTH ? inline(match[1]!, depth + 1) : match[1]
      push(href ? <a key={key++} href={href} target="_blank" rel="noopener noreferrer nofollow" title={href}>{label}</a> : <span key={key++}>{label}</span>)
      i += match[0].length; continue
    }
    if (depth < MAX_DEPTH) {
      if ((match = /^(\*\*|__)(?=\S)(.+?)(?<=\S)\1/.exec(rest))) { push(<strong key={key++}>{inline(match[2]!, depth + 1)}</strong>); i += match[0].length; continue }
      if ((match = /^(\*|_)(?=\S)(.+?)(?<=\S)\1/.exec(rest))) { push(<em key={key++}>{inline(match[2]!, depth + 1)}</em>); i += match[0].length; continue }
      if ((match = /^~~(?=\S)(.+?)(?<=\S)~~/.exec(rest))) { push(<del key={key++}>{inline(match[1]!, depth + 1)}</del>); i += match[0].length; continue }
    }
    buffer += text[i]
    i += 1
  }
  flush()
  return out
}

const FENCE = /^\s{0,3}(```+|~~~+)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
}

function blocks(lines: string[], depth: number): ReactNode[] {
  const out: ReactNode[] = []
  let key = 0
  let i = 0
  const startsBlock = (line: string, next?: string): boolean =>
    FENCE.test(line) || HEADING.test(line) || RULE.test(line) || /^\s{0,3}>/.test(line) || LIST_ITEM.test(line) || (line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes('-'))
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) { i += 1; continue }
    let match: RegExpMatchArray | null
    if ((match = FENCE.exec(line))) {
      const marker = match[1]!
      const body: string[] = []
      i += 1
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) { body.push(lines[i]!); i += 1 }
      i += 1
      out.push(<pre key={key++}><code>{body.join('\n')}</code></pre>)
      continue
    }
    if ((match = HEADING.exec(line))) {
      const Tag = `h${Math.min(6, match[1]!.length + 1)}` as 'h2'
      out.push(<Tag key={key++}>{inline(match[2]!)}</Tag>)
      i += 1
      continue
    }
    if (RULE.test(line)) { out.push(<hr key={key++} />); i += 1; continue }
    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) { quoted.push(lines[i]!.replace(/^\s{0,3}>\s?/, '')); i += 1 }
      out.push(<blockquote key={key++}>{depth < MAX_DEPTH ? blocks(quoted, depth + 1) : quoted.join(' ')}</blockquote>)
      continue
    }
    if (line.includes('|') && lines[i + 1] !== undefined && TABLE_SEPARATOR.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) { rows.push(cells(lines[i]!)); i += 1 }
      out.push(<div key={key++} className="md-table"><table><thead><tr>{head.map((cell, c) => <th key={c}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, r) => <tr key={r}>{head.map((_, c) => <td key={c}>{inline(row[c] ?? '')}</td>)}</tr>)}</tbody></table></div>)
      continue
    }
    if ((match = LIST_ITEM.exec(line))) {
      const baseIndent = match[1]!.length
      const ordered = /\d/.test(match[2]!)
      const items: { text: string; children: string[] }[] = []
      while (i < lines.length) {
        const current = lines[i]!
        const item = LIST_ITEM.exec(current)
        if (item && item[1]!.length <= baseIndent) {
          if (/\d/.test(item[2]!) !== ordered && items.length) break
          items.push({ text: item[3]!, children: [] })
        } else if (items.length && current.trim() && (item || /^\s+\S/.test(current))) {
          items.at(-1)!.children.push(current)
        } else break
        i += 1
      }
      const List = ordered ? 'ol' : 'ul'
      out.push(<List key={key++}>{items.map((item, n) => <li key={n}>{inline(item.text)}{item.children.length > 0 && depth < MAX_DEPTH ? blocks(dedent(item.children), depth + 1) : null}</li>)}</List>)
      continue
    }
    const paragraph: string[] = [line]
    i += 1
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!, lines[i + 1])) { paragraph.push(lines[i]!); i += 1 }
    out.push(<p key={key++}>{inline(paragraph.map(part => part.trim()).join(' '))}</p>)
  }
  return out
}

function dedent(lines: string[]): string[] {
  const indent = Math.min(...lines.filter(line => line.trim()).map(line => /^\s*/.exec(line)![0].length))
  return lines.map(line => line.slice(Number.isFinite(indent) ? indent : 0))
}

/** Markdown de un artefacto (brief, cierre) como elementos React; sin HTML crudo ni recursos remotos. */
export function Markdown({ source }: { source: string }) {
  const truncated = source.length > MARKDOWN_MAX_CHARS
  const text = (truncated ? source.slice(0, MARKDOWN_MAX_CHARS) : source).replace(/\r\n?/g, '\n')
  return <div className="md">{blocks(text.split('\n'), 0)}{truncated && <p className="md-truncated">El contenido es demasiado largo y se muestra recortado.</p>}</div>
}
