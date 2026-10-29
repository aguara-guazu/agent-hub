/**
 * HTML de los correos que el Hub envía a la propia cuenta. Interpreta el mismo subconjunto de markdown que el visor de la app
 * (`frontend/src/components/Markdown.tsx`): el texto se escapa siempre, no se emite HTML del origen, los enlaces solo admiten http, https y
 * mailto, y las imágenes se muestran como enlace para no cargar contenido remoto. Los estilos van en línea y el armado usa tablas porque
 * los clientes de correo descartan hojas de estilo y diseño flexible.
 */

const MAX_CHARS = 200_000
const MAX_INLINE_CHARS = 4_000
const MAX_DEPTH = 6
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
const INK = '#1d2329'
const MUTED = '#5f6b76'
const LINE = '#e3e7eb'
const ACCENT = '#0f8a5f'
const SOFT = '#f3f6f8'

const S = {
  p: `margin:0 0 14px;font:15px/1.6 ${FONT};color:${INK};`,
  h: (level: number) => `margin:${level <= 2 ? 22 : 18}px 0 8px;font:600 ${[0, 20, 18, 16, 15, 14, 14][level]}px/1.35 ${FONT};color:${INK};`,
  list: `margin:0 0 14px;padding-left:22px;font:15px/1.6 ${FONT};color:${INK};`,
  li: 'margin:0 0 6px;',
  quote: `margin:0 0 14px;padding:4px 0 4px 14px;border-left:3px solid ${LINE};color:${MUTED};`,
  pre: `margin:0 0 14px;padding:12px 14px;background:${SOFT};border-radius:8px;font:13px/1.5 ${MONO};color:${INK};white-space:pre-wrap;word-break:break-word;`,
  code: `padding:1px 5px;background:${SOFT};border-radius:4px;font:13px ${MONO};color:${INK};`,
  hr: `border:0;border-top:1px solid ${LINE};margin:20px 0;`,
  table: `border-collapse:collapse;width:100%;margin:0 0 14px;font:14px/1.5 ${FONT};color:${INK};`,
  th: `text-align:left;padding:8px 10px;border-bottom:2px solid ${LINE};font-weight:600;`,
  td: `padding:8px 10px;border-bottom:1px solid ${LINE};vertical-align:top;`,
  a: `color:${ACCENT};text-decoration:underline;`,
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ESCAPES[char]!)

/** `null` salvo para http, https y mailto sin credenciales embebidas. */
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

const anchor = (href: string | null, label: string): string => href ? `<a href="${escapeHtml(href)}" style="${S.a}">${label}</a>` : `<span>${label}</span>`

function inline(text: string, depth = 0): string {
  if (text.length > MAX_INLINE_CHARS) return escapeHtml(text)
  let out = ''
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i)
    let match: RegExpMatchArray | null
    if ((match = /^\\([\\`*_{}[\]()#+\-.!>|~])/.exec(rest))) { out += escapeHtml(match[1]!); i += match[0].length; continue }
    if ((match = /^`([^`]+)`/.exec(rest))) { out += `<code style="${S.code}">${escapeHtml(match[1]!)}</code>`; i += match[0].length; continue }
    if ((match = IMAGE.exec(rest))) { out += anchor(safeHref(match[2]!), escapeHtml(`Imagen: ${match[1] || 'sin descripción'}`)); i += match[0].length; continue }
    if ((match = LINK.exec(rest))) {
      out += anchor(safeHref(match[2]!), depth < MAX_DEPTH ? inline(match[1]!, depth + 1) : escapeHtml(match[1]!))
      i += match[0].length; continue
    }
    if (depth < MAX_DEPTH) {
      if ((match = /^(\*\*|__)(?=\S)(.+?)(?<=\S)\1/.exec(rest))) { out += `<strong>${inline(match[2]!, depth + 1)}</strong>`; i += match[0].length; continue }
      if ((match = /^(\*|_)(?=\S)(.+?)(?<=\S)\1/.exec(rest))) { out += `<em>${inline(match[2]!, depth + 1)}</em>`; i += match[0].length; continue }
      if ((match = /^~~(?=\S)(.+?)(?<=\S)~~/.exec(rest))) { out += `<del>${inline(match[1]!, depth + 1)}</del>`; i += match[0].length; continue }
    }
    out += escapeHtml(text[i]!)
    i += 1
  }
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

function dedent(lines: string[]): string[] {
  const indent = Math.min(...lines.filter(line => line.trim()).map(line => /^\s*/.exec(line)![0].length))
  return lines.map(line => line.slice(Number.isFinite(indent) ? indent : 0))
}

function blocks(lines: string[], depth: number): string {
  let out = ''
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
      out += `<pre style="${S.pre}">${escapeHtml(body.join('\n'))}</pre>`
      continue
    }
    if ((match = HEADING.exec(line))) {
      const level = Math.min(6, match[1]!.length + 1)
      out += `<h${level} style="${S.h(level)}">${inline(match[2]!)}</h${level}>`
      i += 1
      continue
    }
    if (RULE.test(line)) { out += `<hr style="${S.hr}">`; i += 1; continue }
    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) { quoted.push(lines[i]!.replace(/^\s{0,3}>\s?/, '')); i += 1 }
      out += `<blockquote style="${S.quote}">${depth < MAX_DEPTH ? blocks(quoted, depth + 1) : escapeHtml(quoted.join(' '))}</blockquote>`
      continue
    }
    if (line.includes('|') && lines[i + 1] !== undefined && TABLE_SEPARATOR.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) { rows.push(cells(lines[i]!)); i += 1 }
      out += `<table role="presentation" cellpadding="0" cellspacing="0" style="${S.table}"><thead><tr>${head.map(cell => `<th style="${S.th}">${inline(cell)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map(row => `<tr>${head.map((_, c) => `<td style="${S.td}">${inline(row[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`
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
      const tag = ordered ? 'ol' : 'ul'
      out += `<${tag} style="${S.list}">${items.map(item => `<li style="${S.li}">${inline(item.text)}${item.children.length > 0 && depth < MAX_DEPTH ? blocks(dedent(item.children), depth + 1) : ''}</li>`).join('')}</${tag}>`
      continue
    }
    const paragraph: string[] = [line]
    i += 1
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!, lines[i + 1])) { paragraph.push(lines[i]!); i += 1 }
    out += `<p style="${S.p}">${inline(paragraph.map(part => part.trim()).join(' '))}</p>`
  }
  return out
}

/** Fragmento HTML con estilos en línea para un markdown de artefacto; recorta lo que supera el tope y lo avisa. */
export function markdownToEmailHtml(source: string): string {
  const truncated = source.length > MAX_CHARS
  const text = (truncated ? source.slice(0, MAX_CHARS) : source).replace(/\r\n?/g, '\n')
  return blocks(text.split('\n'), 0) + (truncated ? `<p style="${S.p}color:${MUTED};">El contenido es demasiado largo y se muestra recortado; el completo está en la app.</p>` : '')
}

/** Bloque de decisión: ítems pendientes, la línea de respuesta y el vencimiento. El texto de cada parte ya viene del pie en texto plano. */
export interface EmailDecision {
  items: Array<{ ordinal: number; summary: string }>
  reply_line: string
  expires: string
}

function decisionHtml(decision: EmailDecision): string {
  return `<tr><td style="padding:0 32px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};border:1px solid ${LINE};border-radius:10px;">`
    + `<tr><td style="padding:18px 20px;font:15px/1.6 ${FONT};color:${INK};">`
    + `<p style="margin:0 0 10px;font-weight:600;">Para decidir, responde a este mismo correo con una sola línea</p>`
    + `<ol style="${S.list}margin-bottom:12px;">${decision.items.map(item => `<li style="${S.li}" value="${item.ordinal}">${escapeHtml(item.summary)}</li>`).join('')}</ol>`
    + `<p style="margin:0 0 10px;padding:10px 12px;background:#ffffff;border:1px solid ${LINE};border-radius:8px;font:13px/1.6 ${MONO};color:${INK};">${escapeHtml(decision.reply_line)}</p>`
    + `<p style="margin:0;font-size:13px;color:${MUTED};">Vence: ${escapeHtml(decision.expires)}. También puedes aprobar desde la app.</p>`
    + '</td></tr></table></td></tr>'
}

/**
 * Documento completo del correo: encabezado con la marca, título, cuerpo interpretado, bloque de decisión opcional y pie. `preheader` es el
 * texto de vista previa que muestran las bandejas; se oculta en el cuerpo.
 */
export function renderSelfEmail(input: { title: string; markdown: string; decision?: EmailDecision | undefined; preheader?: string | undefined }): string {
  const preheader = (input.preheader ?? input.markdown.replace(/[#*_`>|\-[\]()]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 140)
  return '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(input.title)}</title></head>`
    + `<body style="margin:0;padding:0;background:#eef1f4;">`
    + `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f4;"><tr><td align="center" style="padding:28px 12px;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid ${LINE};border-radius:14px;">`
    + `<tr><td style="padding:22px 32px 0;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>`
    + `<td style="width:28px;height:28px;background:${ACCENT};border-radius:8px;text-align:center;vertical-align:middle;font:700 15px/28px ${FONT};color:#ffffff;">Y</td>`
    + `<td style="padding-left:10px;font:600 14px ${FONT};color:${MUTED};letter-spacing:0.2px;">Agent Hub</td></tr></table></td></tr>`
    + `<tr><td style="padding:18px 32px 6px;"><h1 style="margin:0;font:700 22px/1.3 ${FONT};color:${INK};">${escapeHtml(input.title)}</h1></td></tr>`
    + `<tr><td style="padding:12px 32px 14px;">${markdownToEmailHtml(input.markdown)}</td></tr>`
    + (input.decision ? decisionHtml(input.decision) : '')
    + `<tr><td style="padding:16px 32px 22px;border-top:1px solid ${LINE};font:12px/1.6 ${FONT};color:${MUTED};">`
    + 'Agent Hub envió este correo a tu propia cuenta. Los canales de cada automatización se cambian en la app, en Automatizaciones.</td></tr>'
    + '</table></td></tr></table></body></html>'
}
