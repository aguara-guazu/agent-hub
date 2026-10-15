import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { redactSecrets } from './secrets.js'

export const ISSUES_URL = 'https://github.com/aguara-guazu/agent-hub/issues/new'
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
/** Past this size a log moves to `<name>.1`, so each log keeps at most twice this on disk. */
const MAX_LOG_BYTES = 2 * 1024 * 1024
/** Very long prefilled URLs may not open; the link carries the newest log lines and the clipboard the full report. */
const MAX_ISSUE_URL = 7000
const LOG_STEPS = [200, 120, 60, 30, 10, 0]

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Diagnostics need stricter filtering than imported prose: JSON, headers and short tokens are credentials too. */
export function redactDiagnostics(text: string): string {
  return redactSecrets(text).text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[credencial omitida]')
    .replace(/(["']?\b(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/gi,
      '$1[credencial omitida]')
}

/** Text meant for a public issue: credentials (secrets.ts), email addresses and the user's home directory are replaced. */
export function redactReport(text: string, home?: string): string {
  let result = redactDiagnostics(text).replace(EMAIL, '[email]')
  if (home && home.length > 3) {
    // Native, forward-slash (file URLs) and JSON-escaped spellings; Windows and macOS compare paths case-insensitively.
    const forward = home.replace(/\\/g, '/')
    const variants = new Set([home, forward, encodeURI(forward), home.replace(/\//g, '\\'), home.replace(/\\/g, '\\\\')])
    for (const variant of [...variants].sort((a, b) => b.length - a.length)) result = result.replace(new RegExp(escapeRegExp(variant), 'gi'), '~')
  }
  return result
}

/** Appends timestamped lines to a log file with credentials already replaced; logging never throws into the caller. */
export class LogFile {
  private size = 0
  constructor(readonly path: string) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      this.size = statSync(path).size
    } catch { this.size = 0 }
  }
  write(text: string, prefix = '') {
    const lines = redactDiagnostics(text).slice(-64_000).split(/\r?\n/).filter(line => line.trim())
    if (!lines.length) return
    const stamp = new Date().toISOString()
    const chunk = lines.map(line => `${stamp} ${prefix}${line}\n`).join('')
    try {
      if (this.size && this.size + Buffer.byteLength(chunk) > MAX_LOG_BYTES) { renameSync(this.path, `${this.path}.1`); this.size = 0 }
    } catch { return /* Retry rotation on the next write; do not grow a locked log without bound. */ }
    try {
      appendFileSync(this.path, chunk, { mode: 0o600 })
      this.size += Buffer.byteLength(chunk)
    } catch { /* a full or read-only disk must not take the process down */ }
  }
  /** Writes a stream line by line; a partial line waits for its newline or the end of the stream. */
  follow(stream: NodeJS.ReadableStream, prefix = '') {
    let rest = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      const text = rest + chunk, cut = text.lastIndexOf('\n')
      if (cut < 0) {
        if (text.length > 64_000) { this.write(text, prefix); rest = '' } else rest = text
        return
      }
      rest = text.slice(cut + 1)
      this.write(text.slice(0, cut), prefix)
    })
    stream.on('end', () => { if (rest) this.write(rest, prefix); rest = '' })
  }
}

/** Last `count` lines of a log, reaching into the rotated `<name>.1` when the current file is short. */
export function tailLog(path: string, count: number): string[] {
  const read = (file: string) => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
  const lines = read(path)
  return (lines.length >= count ? lines : [...read(`${path}.1`), ...lines]).slice(-count)
}

export interface ReportInput {
  title: string
  summary: string
  error: string
  environment: Record<string, string>
  details?: Record<string, string>
  logs: { name: string; lines: string[] }[]
  home?: string
}

/** Markdown issue body (full) and a prefilled new-issue URL that fits MAX_ISSUE_URL; both pass through redactReport. */
export function buildReport(input: ReportInput): { title: string; text: string; url: string } {
  const fence = (text: string) => text.replace(/```/g, "'''")
  const list = (values: Record<string, string>) => Object.entries(values).map(([key, value]) => `- ${key}: ${value}`).join('\n')
  const body = (lines: number, truncated: boolean) => [
    '### Qué pasó', input.summary, '',
    '### Entorno', list(input.environment), '',
    ...(input.details && Object.keys(input.details).length ? ['### Detalle', list(input.details), ''] : []),
    '### Error', '```', fence(input.error), '```', '',
    ...input.logs.filter(log => log.lines.length && lines > 0).flatMap(log => {
      const shown = log.lines.slice(-lines)
      return [`### Log: ${log.name} (últimas ${shown.length} líneas)`, '```', fence(shown.join('\n')), '```', '']
    }),
    ...(truncated ? ['_El log se recortó para que entre en el enlace; usá «Copiar reporte» para incluir el reporte completo._'] : []),
  ].join('\n')
  const title = redactReport(input.title, input.home).slice(0, 200)
  const text = redactReport(body(LOG_STEPS[0]!, false), input.home)
  let url = ''
  for (const lines of LOG_STEPS) {
    const candidate = `${ISSUES_URL}?${new URLSearchParams({ title, body: redactReport(body(lines, lines !== LOG_STEPS[0]), input.home) })}`
    url = candidate
    if (candidate.length <= MAX_ISSUE_URL) break
  }
  if (url.length > MAX_ISSUE_URL) url = `${ISSUES_URL}?${new URLSearchParams({ title, body: '_Usá «Copiar reporte» en Agent Hub y pegá el texto aquí._' })}`
  return { title, text, url }
}
