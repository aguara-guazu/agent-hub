import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { renameRetrySync } from "@agenthub/gateway/platform"
import { redactSecrets } from './secrets.js'

export const ISSUES_URL = 'https://github.com/aguara-guazu/agent-hub/issues/new'
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
/** Past this size the active log moves to `<name>.1`; the previous `.1` is kept as `<name>.<epoch ms>` under the folder budget. */
export const LOG_SEGMENT_BYTES = 2 * 1024 * 1024
/** Every log in the folder, active and rotated, from every process; the oldest rotated segments are discarded first. */
export const LOG_DIR_BUDGET_BYTES = 50 * 1024 * 1024
const LOG_RESCAN_BYTES = 256 * 1024
const LOG_PRUNE_TARGET = LOG_DIR_BUDGET_BYTES
const SEGMENT = /^(.+\.log)\.(\d+)$/
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

interface LogEntry { path: string; size: number; active: boolean; order: number; dev: number; ino: number; mtimeMs: number }
const LOG_LOCK_NAME = ".agenthub-log.lock"
const STALE_LOG_LOCK_MS = 60_000

/** Never follow a log, segment, or lock symlink. */
function isRegularFile(path: string, missing = false) {
  try { return lstatSync(path).isFile() } catch (error) { return missing && (error as NodeJS.ErrnoException).code === "ENOENT" }
}

function sameFile(path: string, identity: { dev: number; ino: number; mtimeMs?: number }) {
  try {
    const current = lstatSync(path)
    return current.isFile() && current.dev === identity.dev && current.ino === identity.ino && (identity.mtimeMs === undefined || current.mtimeMs === identity.mtimeMs)
  } catch { return false }
}

/** Serializes rotation and pruning between Hub processes. A dead owner's lock is reclaimed after one minute. */
function withLogLock<T>(directory: string, work: () => T): T | undefined {
  const path = join(directory, LOG_LOCK_NAME)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = openSync(path, "wx", 0o600)
      let identity: ReturnType<typeof lstatSync>
      try { identity = lstatSync(path) } finally { closeSync(descriptor) }
      try { return work() } finally {
        try {
          if (sameFile(path, identity)) unlinkSync(path)
        } catch { /* A removed or replaced lock is not ours to clean up. */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined
      try {
        const lock = lstatSync(path)
        if (!lock.isFile() || Date.now() - lock.mtimeMs <= STALE_LOG_LOCK_MS || !sameFile(path, lock)) return undefined
        unlinkSync(path)
      } catch { return undefined }
    }
  }
  return undefined
}

/** Logs of a folder: `*.log` are active; `<name>.log.1` is the newest rotated segment of each log and `<name>.log.<epoch ms>` the older ones. */
function logEntries(directory: string): LogEntry[] {
  const entries: LogEntry[] = []
  for (const name of readdirSync(directory)) {
    const segment = SEGMENT.exec(name)
    if (!segment && !name.endsWith(".log")) continue
    const path = join(directory, name)
    try {
      const stat = lstatSync(path)
      if (stat.isFile()) entries.push({ path, size: stat.size, active: !segment, order: !segment ? Infinity : segment[2] === "1" ? Number.MAX_SAFE_INTEGER : Number(segment[2]), dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs })
    } catch { /* Removed meanwhile or an unsafe link. */ }
  }
  return entries
}
/** Discards the oldest rotated segments until the folder fits; active logs are never removed. Returns the remaining total. */
function pruneLogsUnlocked(directory: string, target = LOG_PRUNE_TARGET): number {
  let entries: LogEntry[]
  try { entries = logEntries(directory) } catch { return 0 }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0)
  for (const entry of entries.filter(item => !item.active).sort((a, b) => a.order - b.order)) {
    if (total <= target) break
    try { if (sameFile(entry.path, entry)) { unlinkSync(entry.path); total -= entry.size } } catch { /* Another writer removed it. */ }
  }
  return total
}
export function pruneLogs(directory: string, target = LOG_PRUNE_TARGET): number {
  return withLogLock(directory, () => pruneLogsUnlocked(directory, target)) ?? 0
}
/** Rotated segments of one log, newest first. */
function segmentsOf(path: string): string[] {
  const base = basename(path)
  try {
    return readdirSync(dirname(path)).map(name => SEGMENT.exec(name)).filter((match): match is RegExpExecArray => Boolean(match && match[1] === base))
      .sort((a, b) => (b[2] === "1" ? Infinity : Number(b[2])) - (a[2] === "1" ? Infinity : Number(a[2])))
      .map(match => join(dirname(path), match[0])).filter(file => isRegularFile(file))
  } catch { return [] }
}
function uniqueSegmentPath(path: string) {
  let suffix = Date.now()
  for (;;) {
    try { lstatSync(`${path}.${suffix}`); suffix++ } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${path}.${suffix}`
      throw error
    }
  }
}

export function appendLogChunk(activePath: string, chunk: Buffer, fs = { openSync, writeSync, fstatSync, lstatSync, closeSync }) {
  let offset = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(activePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      const opened = fs.fstatSync(descriptor), current = fs.lstatSync(activePath)
      if (!opened.isFile()) return offset
      if ((opened.dev !== current.dev || opened.ino !== current.ino) && attempt < 2) continue
      while (offset < chunk.length) {
        const written = fs.writeSync(descriptor, chunk, offset, chunk.length - offset)
        if (!written) break
        offset += written
      }
      return offset
    } catch { return offset }
    finally { if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch { /* Logging must not escape. */ } }
  }
  return offset
}

/** Appends timestamped lines to a log file with credentials already replaced; logging never throws into the caller. */
export class LogFile {
  private size = 0
  private sinceScan = 0
  private directory: string
  private activePath: string
  constructor(readonly path: string) {
    const directory = dirname(path)
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      this.directory = realpathSync(directory)
      this.activePath = join(this.directory, basename(path))
      this.size = this.activeSize()
    } catch {
      this.directory = directory
      this.activePath = path
    }
  }
  private activeSize() {
    try {
      const stat = lstatSync(this.activePath)
      return stat.isFile() ? stat.size : 0
    } catch { return 0 }
  }
  private appendActive(chunk: string) {
    const buffer = Buffer.from(chunk)
    let written = appendLogChunk(this.activePath, buffer)
    if (written < buffer.length) written += appendLogChunk(this.activePath, buffer.subarray(written))
    return written
  }
  write(text: string, prefix = '') {
    const lines = redactDiagnostics(text).slice(-64_000).split(/\r?\n/).filter(line => line.trim())
    if (!lines.length) return
    const stamp = new Date().toISOString()
    this.append(lines.map(line => `${stamp} ${prefix}${line}\n`).join(''))
  }
  /** Writes lines already redacted by the caller (structured logs), with the same rotation and folder budget. */
  protected append(chunk: string) {
    const bytes = Buffer.byteLength(chunk)
    const maintain = this.size + bytes > LOG_SEGMENT_BYTES || this.sinceScan + bytes >= LOG_RESCAN_BYTES
    if (maintain && withLogLock(this.directory, () => {
      this.size = this.activeSize()
      if (this.size && this.size + bytes > LOG_SEGMENT_BYTES) try {
        const latest = `${this.activePath}.1`
        if (isRegularFile(latest)) renameRetrySync(latest, uniqueSegmentPath(this.activePath))
        else if (!isRegularFile(latest, true)) throw new Error("Unsafe rotated log")
        renameRetrySync(this.activePath, latest)
        this.size = 0
      } catch { /* Keep the triggering chunk in the active file and retry rotation later. */ }
      const written = this.appendActive(chunk)
      if (!written) return false
      this.size += written
      this.sinceScan += written
      pruneLogsUnlocked(this.directory)
      this.sinceScan = 0
      return true
    }) === true) return
    const written = this.appendActive(chunk)
    if (written) {
      this.size += written
      this.sinceScan += written
    }
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

export type HubLogValue = string | number | boolean | null | undefined
const LOG_EVENT_NAME = /^[a-z][a-z0-9_]{0,39}$/
const RESERVED_LOG_FIELDS = new Set(["ts", "component", "event"])
const MAX_LOG_EVENT_BYTES = 4095
/** JSON lines of Hub activity: ids, states, causes and durations only. Every string value is redacted before it is serialized. */
export class HubLog extends LogFile {
  event(component: string, event: string, fields: Record<string, unknown> = {}) {
    try {
      if (!LOG_EVENT_NAME.test(component) || !LOG_EVENT_NAME.test(event)) return
      const record: Record<string, HubLogValue> = { ts: new Date().toISOString(), component, event }
      for (const [key, raw] of Object.entries(fields)) {
        if (Object.keys(record).length >= 35 || RESERVED_LOG_FIELDS.has(key) || !LOG_EVENT_NAME.test(key)) continue
        const value = typeof raw === "bigint" ? String(raw) : raw
        if (typeof value === "string") record[key] = redactDiagnostics(value).slice(0, 500)
        else if (typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" || value === null) record[key] = value
      }
      let encoded = JSON.stringify(record)
      if (Buffer.byteLength(encoded) > MAX_LOG_EVENT_BYTES) {
        for (const key of Object.keys(record)) if (typeof record[key] === "string" && !RESERVED_LOG_FIELDS.has(key)) record[key] = record[key]!.slice(0, 64)
        encoded = JSON.stringify(record)
      }
      if (Buffer.byteLength(encoded) <= MAX_LOG_EVENT_BYTES) this.append(`${encoded}\n`)
    } catch { /* Logging must not escape. */ }
  }
}
const hubLogs = new Map<string, HubLog>()
function logPath(memoryDirectory: string) {
  const directory = process.env.AGENTHUB_LOG_DIR || join(memoryDirectory, "logs")
  try { mkdirSync(directory, { recursive: true, mode: 0o700 }); return join(realpathSync(directory), "hub.log") } catch { return join(directory, "hub.log") }
}
/** The core's history log, next to core.log when the desktop passes its folder; a standalone core keeps it next to the memory. */
export function hubLog(memoryDirectory: string): HubLog {
  const path = logPath(memoryDirectory)
  let log = hubLogs.get(path)
  if (!log) hubLogs.set(path, log = new HubLog(path))
  return log
}

/** Last `count` lines of a log, reaching into its newest rotated segments when the current file is short. */
export function tailLog(path: string, count: number): string[] {
  const read = (file: string) => { try { return isRegularFile(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [] } catch { return [] } }
  let lines = read(path)
  for (const segment of segmentsOf(path)) {
    if (lines.length >= count) break
    lines = [...read(segment), ...lines]
  }
  return lines.slice(-count)
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
