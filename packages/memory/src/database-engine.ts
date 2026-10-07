// Runs inside a worker thread (see database.ts). Under vitest this file is loaded straight from
// src by Node's type stripping, so it may only import node: builtins and use erasable TypeScript.
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'

export type EngineRole = 'writer' | 'reader' | 'lock'
export interface EngineRequest { id: number; op: 'query' | 'exec' | 'many' | 'cursor-open' | 'cursor-next' | 'cursor-close' | 'lock' | 'unlock' | 'close'; sql?: string; params?: unknown[]; rows?: unknown[][]; cursor?: number; size?: number }
export type EngineResponse = { id: number; result: unknown } | { id: number; error: { message: string; code?: string | undefined; errcode?: number | undefined } }

type Conversion = 'json' | 'bool' | 'omit' | null
interface Prepared { statement: StatementSync; returnsRows: boolean; columns: { key: string; name: string; conversion: Conversion }[] | null }

/**
 * Result typing rules, matching what the pg driver returned before:
 * - columns declared JSON are parsed, BOOLEAN become true/false;
 * - computed columns opt in with an alias suffix: `AS "project_ids:json"`, `AS "current:bool"`;
 * - the `rid` rowid alias (stable key for FTS5) is never returned.
 */
function conversionFor(column: { column: string | null; name: string; type: string | null }): { name: string; conversion: Conversion } {
  if (column.column === 'rid') return { name: column.name, conversion: 'omit' }
  const suffix = /^(.*):(json|bool)$/.exec(column.name)
  if (suffix) return { name: suffix[1]!, conversion: suffix[2] as Conversion }
  const type = column.type?.toUpperCase() ?? ''
  if (type === 'JSON') return { name: column.name, conversion: 'json' }
  if (type === 'BOOLEAN') return { name: column.name, conversion: 'bool' }
  return { name: column.name, conversion: null }
}

/** Bind native named $n parameters: Node 22 treats ?n as named, not anonymous parameters.
 * Keeping the SQL intact also preserves literal dollar amounts and repeated/out-of-order references.
 */
function bindParams(params: unknown[]): Record<string, never> {
  return Object.fromEntries(params.map((value, index) => [`$${index + 1}`, bindValue(value)])) as Record<string, never>
}

// Query vectors travel once per statement and are referenced by token, instead of copying a
// 3 KB BLOB argument into every vec_distance() call (~1 GB of copies over 300k rows).
const queryVectors = new Map<number, Float32Array>()
let nextVector = 1, boundVectors: number[] = []
function takeBoundVectors(): number[] { const tokens = boundVectors; boundVectors = []; return tokens }
function releaseVectors(tokens: number[]): void { for (const token of tokens) queryVectors.delete(token) }

export function bindValue(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'object' && (value as { $vector?: unknown }).$vector instanceof Float32Array) {
    const token = nextVector++
    queryVectors.set(token, (value as { $vector: Float32Array }).$vector)
    boundVectors.push(token)
    return token
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value
  return JSON.stringify(value)
}

type LikeToken = { literal: string } | '%' | '_'
/** LIKE matching with a single retry position, never a backtracking regular expression. */
function compileLike(pattern: string): (value: string) => boolean {
  const tokens: LikeToken[] = []
  const chars = Array.from(pattern.toLowerCase())
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!
    if (char === '\\') {
      if (++i === chars.length) throw new Error('El patrón LIKE no puede terminar con un escape')
      tokens.push({ literal: chars[i]! })
    } else if (char === '%' || char === '_') {
      if (char !== '%' || tokens.at(-1) !== '%') tokens.push(char)
    } else tokens.push({ literal: char })
  }
  // Almost all callers search a literal substring, prefix or suffix. Avoid per-character work.
  const first = tokens[0] === '%' ? 1 : 0, last = tokens.at(-1) === '%' ? tokens.length - 1 : tokens.length
  const middle = tokens.slice(first, last)
  if (middle.every(t => typeof t === 'object')) {
    const literal = middle.map(t => (t as { literal: string }).literal).join('')
    return value => {
      const text = value.toLowerCase()
      return first ? (last < tokens.length ? text.includes(literal) : text.endsWith(literal))
        : last < tokens.length ? text.startsWith(literal) : text === literal
    }
  }
  return value => {
    const text = Array.from(value.toLowerCase())
    let pos = 0, token = 0, star = -1, retry = 0
    while (pos < text.length) {
      const next = tokens[token]
      if (next === '_' || (typeof next === 'object' && next.literal === text[pos])) { pos++; token++ }
      else if (next === '%') { star = token++; retry = pos }
      else if (star >= 0) { token = star + 1; pos = ++retry }
      else return false
    }
    while (tokens[token] === '%') token++
    return token === tokens.length
  }
}
const likeCache = new Map<string, (value: string) => boolean>()
function ilike(value: unknown, pattern: unknown): number | null {
  if (value === null || pattern === null) return null
  const key = String(pattern)
  let matches = likeCache.get(key)
  if (!matches) {
    matches = compileLike(key)
    if (likeCache.size > 500) likeCache.clear()
    likeCache.set(key, matches)
  }
  return matches(String(value)) ? 1 : 0
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? JSON.parse(value) : value
}
/** PostgreSQL `jsonb || jsonb`: shallow object merge (null values are kept), array concatenation. */
function jsonbMerge(left: unknown, right: unknown): string | null {
  if (left === null || right === null) return null
  const a = parseJson(left), b = parseJson(right)
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify([...(Array.isArray(a) ? a : [a]), ...(Array.isArray(b) ? b : [b])])
  if (a && b && typeof a === 'object' && typeof b === 'object') return JSON.stringify({ ...a, ...b })
  return JSON.stringify(b)
}
/** PostgreSQL `jsonb @> jsonb` containment. */
function contains(a: unknown, b: unknown): boolean {
  if (Array.isArray(b)) return Array.isArray(a) && b.every(item => a.some(candidate => contains(candidate, item)))
  if (b && typeof b === 'object') return Boolean(a) && typeof a === 'object' && !Array.isArray(a)
    && Object.entries(b).every(([key, value]) => key in (a as object) && contains((a as Record<string, unknown>)[key], value))
  if (Array.isArray(a)) return a.some(item => contains(item, b))
  return a === b
}
/** `memory_entity_text` from the PostgreSQL schema; entity embeddings hash this exact text. */
export function entityText(title: unknown, data: unknown): string {
  const record = (parseJson(data) ?? {}) as Record<string, unknown>
  const field = (key: string) => {
    const value = record[key]
    if (value === null || value === undefined) return ''
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
  return `${String(title)}\n${field('description')}\n${field('text')}\n${field('email')}\n${field('category')}\n${field('status')}`
}
function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const date = new Date(typeof value === 'number' ? value : String(value))
  if (Number.isNaN(date.getTime())) throw new Error(`Fecha inválida: ${String(value)}`)
  return date.toISOString()
}
/** Cosine distance between unit vectors stored as float32 BLOBs (see `vector()` in database.ts). */
function vectorDistance(a: unknown, b: unknown): number | null {
  if (!(a instanceof Uint8Array)) return null
  const y = typeof b === 'number' ? queryVectors.get(b) : b instanceof Uint8Array
    ? (b.byteOffset % 4 === 0 ? new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) : new Float32Array(b.slice().buffer)) : undefined
  if (!y || y.length * 4 !== a.byteLength) return null
  const x = a.byteOffset % 4 === 0 ? new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4) : new Float32Array(a.slice().buffer)
  let dot = 0
  for (let i = 0; i < x.length; i++) dot += x[i]! * y[i]!
  return 1 - dot
}

export function registerFunctions(db: DatabaseSync): void {
  const now = () => new Date().toISOString()
  db.function('now', { deterministic: false }, now)
  db.function('clock_timestamp', { deterministic: false }, now)
  db.function('gen_random_uuid', { deterministic: false }, () => randomUUID())
  // Built-in lower()/upper() only fold ASCII; PostgreSQL folds Unicode ("ÉLIDA" → "élida").
  db.function('lower', { deterministic: true }, (value: unknown) => value === null ? null : String(value).toLowerCase())
  db.function('upper', { deterministic: true }, (value: unknown) => value === null ? null : String(value).toUpperCase())
  db.function('md5', { deterministic: true }, (value: unknown) => value === null ? null : createHash('md5').update(String(value)).digest('hex'))
  db.function('ilike', { deterministic: true }, ilike)
  const regexpCache = new Map<string, RegExp>()
  db.function('regexp_i', { deterministic: true }, (value: unknown, pattern: unknown) => {
    if (value === null || pattern === null) return null
    const key = String(pattern)
    let regexp = regexpCache.get(key)
    if (!regexp) {
      regexp = new RegExp(key, 'iu')
      if (regexpCache.size > 500) regexpCache.clear()
      regexpCache.set(key, regexp)
    }
    return regexp.test(String(value)) ? 1 : 0
  })
  db.function('jsonb_merge', { deterministic: true }, jsonbMerge)
  db.function('jsonb_contains', { deterministic: true }, (a: unknown, b: unknown) => a === null || b === null ? null : contains(parseJson(a), parseJson(b)) ? 1 : 0)
  db.function('memory_entity_text', { deterministic: true }, (title: unknown, data: unknown) => entityText(title, data))
  db.function('ts', { deterministic: true }, normalizeTimestamp)
  db.function('vec_distance', { deterministic: true }, vectorDistance)
}

export class SqliteEngine {
  readonly db: DatabaseSync
  private readonly statements = new Map<string, Prepared>()
  private readonly cursors = new Map<number, { iterator: Iterator<Record<string, unknown>>; prepared: Prepared; vectors: number[] }>()
  private nextCursor = 1
  private locked = false

  constructor(file: string, role: EngineRole, busyTimeoutMs = 30_000) {
    this.db = new DatabaseSync(file, { timeout: role === 'lock' ? 200 : busyTimeoutMs, enableForeignKeyConstraints: true })
    if (role === 'lock') return
    registerFunctions(this.db)
    this.db.exec('PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536; PRAGMA mmap_size=1073741824')
    if (role === 'writer') this.db.exec('PRAGMA journal_mode=WAL')
    else this.db.exec('PRAGMA query_only=ON')
  }

  private prepare(sql: string): Prepared {
    let prepared = this.statements.get(sql)
    if (prepared) { this.statements.delete(sql); this.statements.set(sql, prepared); return prepared }
    const statement = this.db.prepare(sql)
    // Query builders can reserve positions that a particular branch does not use.
    statement.setAllowUnknownNamedParameters(true)
    const meta = statement.columns()
    const columns = meta.length ? meta.map(column => ({ key: column.name, ...conversionFor(column) })) : null
    prepared = { statement, returnsRows: meta.length > 0, columns: columns?.some(c => c.conversion || c.key !== c.name) ? columns : null }
    this.statements.set(sql, prepared)
    if (this.statements.size > 300) this.statements.delete(this.statements.keys().next().value!)
    return prepared
  }

  private convert(prepared: Prepared, row: Record<string, unknown>): Record<string, unknown> {
    if (!prepared.columns) return row
    const out: Record<string, unknown> = {}
    for (const column of prepared.columns) {
      const value = row[column.key]
      if (column.conversion === 'omit') continue
      out[column.name] = column.conversion === 'json' ? parseJson(value) : column.conversion === 'bool' ? (value === null || value === undefined ? null : Boolean(value)) : value
    }
    return out
  }

  query(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const prepared = this.prepare(sql)
    const values = bindParams(params)
    const vectors = takeBoundVectors()
    try {
      if (!prepared.returnsRows) { prepared.statement.run(values); return [] }
      return (prepared.statement.all(values) as Record<string, unknown>[]).map(row => this.convert(prepared, row))
    } finally { releaseVectors(vectors) }
  }

  exec(sql: string): void { this.db.exec(sql) }

  /** Runs one statement for every parameter list; the caller provides the transaction. */
  many(sql: string, rows: unknown[][]): number {
    const statement = this.prepare(sql).statement
    for (const params of rows) {
      const values = bindParams(params)
      const vectors = takeBoundVectors()
      try { statement.run(values) } finally { releaseVectors(vectors) }
    }
    return rows.length
  }

  openCursor(sql: string, params: unknown[] = []): number {
    const prepared = this.prepare(sql)
    const id = this.nextCursor++
    const values = bindParams(params)
    this.cursors.set(id, { prepared, vectors: takeBoundVectors(), iterator: prepared.statement.iterate(values) as Iterator<Record<string, unknown>> })
    return id
  }
  nextRows(cursor: number, size: number): Record<string, unknown>[] {
    const entry = this.cursors.get(cursor)
    if (!entry) throw new Error('Cursor inexistente')
    const rows: Record<string, unknown>[] = []
    while (rows.length < size) {
      const next = entry.iterator.next()
      if (next.done) { this.cursors.delete(cursor); releaseVectors(entry.vectors); break }
      rows.push(this.convert(entry.prepared, next.value))
    }
    return rows
  }
  closeCursor(cursor: number): void {
    const entry = this.cursors.get(cursor)
    this.cursors.delete(cursor)
    entry?.iterator.return?.()
    if (entry) releaseVectors(entry.vectors)
  }

  /** Cross-process mutex: a RESERVED lock on a dedicated file, released by the OS if the process dies. */
  tryLock(): boolean {
    if (this.locked) return true
    try { this.db.exec('BEGIN IMMEDIATE'); this.locked = true; return true } catch (error) {
      if ((error as { errcode?: number }).errcode === 5) return false
      throw error
    }
  }
  unlock(): void { if (this.locked) { this.db.exec('ROLLBACK'); this.locked = false } }
  close(): void { for (const cursor of [...this.cursors.keys()]) this.closeCursor(cursor); this.db.close() }
}

function serve(): void {
  const { file, role, busyTimeoutMs } = workerData as { file: string; role: EngineRole; busyTimeoutMs: number }
  const port = parentPort!
  let engine: SqliteEngine
  try { engine = new SqliteEngine(file, role, busyTimeoutMs) } catch (error) {
    port.on('message', (request: EngineRequest) => port.postMessage(failure(request.id, error)))
    return
  }
  const lockWaiters: number[] = []
  const attemptLock = () => {
    if (!lockWaiters.length) return
    try {
      if (engine.tryLock()) { port.postMessage({ id: lockWaiters.shift()!, result: null } satisfies EngineResponse); return }
      setTimeout(attemptLock, 50)
    } catch (error) { port.postMessage(failure(lockWaiters.shift()!, error)) }
  }
  port.on('message', (request: EngineRequest) => {
    try {
      let result: unknown = null
      if (request.op === 'query') result = engine.query(request.sql!, request.params ?? [])
      else if (request.op === 'exec') engine.exec(request.sql!)
      else if (request.op === 'many') result = engine.many(request.sql!, request.rows ?? [])
      else if (request.op === 'cursor-open') result = engine.openCursor(request.sql!, request.params ?? [])
      else if (request.op === 'cursor-next') result = engine.nextRows(request.cursor!, request.size ?? 128)
      else if (request.op === 'cursor-close') engine.closeCursor(request.cursor!)
      else if (request.op === 'lock') { lockWaiters.push(request.id); if (lockWaiters.length === 1) attemptLock(); return }
      else if (request.op === 'unlock') engine.unlock()
      else if (request.op === 'close') { engine.close(); port.postMessage({ id: request.id, result: null }); port.close(); return }
      port.postMessage({ id: request.id, result } satisfies EngineResponse)
    } catch (error) { port.postMessage(failure(request.id, error)) }
  })
}
function failure(id: number, error: unknown): EngineResponse {
  const e = error as { message?: string; code?: string; errcode?: number }
  return { id, error: { message: e?.message ?? String(error), code: e?.code, errcode: e?.errcode } }
}

if (!isMainThread && (workerData as { agenthubMemoryEngine?: boolean } | null)?.agenthubMemoryEngine) serve()
