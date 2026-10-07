import { AsyncLocalStorage } from 'node:async_hooks'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { migrations } from './migrations.js'
import type { EngineRequest, EngineResponse, EngineRole } from './database-engine.js'

export interface Sql {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>
}
/** A transaction handle; `batches` streams large result sets on the same connection and snapshot. */
export interface TransactionSql extends Sql {
  batches<T = Record<string, any>>(sql: string, params?: unknown[], size?: number): AsyncGenerator<T[]>
  /** Executes `sql` once per parameter list inside the worker thread (bulk import). */
  many(sql: string, rows: unknown[][]): Promise<number>
}
export class DatabaseError extends Error {
  constructor(message: string, readonly code?: string, readonly errcode?: number) { super(message) }
}

/** Float32 unit vector as stored in `embeddings`/`entity_embeddings`; `vec_distance` is then 1 - dot product. */
export function vector(values: readonly number[]): Uint8Array {
  const out = new Float32Array(values.length)
  let norm = 0
  for (const value of values) norm += value * value
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < values.length; i++) out[i] = values[i]! / norm
  return new Uint8Array(out.buffer)
}
/** Search vector parameter for `vec_distance(embedding, $n)`; bound once per statement instead of per row. */
export function queryVector(values: readonly number[]): { $vector: Float32Array } {
  return { $vector: new Float32Array(vector(values).buffer) }
}
export function vectorValues(blob: Uint8Array): number[] {
  return Array.from(new Float32Array(blob.slice().buffer))
}
/** Converts a value from PostgreSQL rows or JSON backups into the storage form of a SQLite column type. */
export function storageConverter(type: string): (value: unknown) => unknown {
  const upper = type.toUpperCase()
  if (upper === 'JSON') return value => value === null || value === undefined ? null : JSON.stringify(value)
  if (upper === 'BOOLEAN') return value => value === null || value === undefined ? null : value ? 1 : 0
  if (upper === 'INTEGER') return value => value === null || value === undefined ? null : Number(value)
  if (upper === 'BLOB') return value => value === null || value === undefined ? null : vector(typeof value === 'string' ? JSON.parse(value) as number[] : value as number[])
  return value => value === undefined ? null : value
}

function engineUrl(): URL {
  const compiled = new URL('./database-engine.js', import.meta.url)
  return existsSync(fileURLToPath(compiled)) ? compiled : new URL('./database-engine.ts', import.meta.url)
}

class Lane {
  private readonly worker: Worker
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private seq = 0
  private tail: Promise<unknown> = Promise.resolve()
  private failure: Error | null = null
  waiting = 0

  constructor(file: string, role: EngineRole, busyTimeoutMs: number) {
    this.worker = new Worker(engineUrl(), { workerData: { agenthubMemoryEngine: true, file, role, busyTimeoutMs } })
    this.worker.unref()
    this.worker.on('message', (response: EngineResponse) => {
      const entry = this.pending.get(response.id)
      if (!entry) return
      this.pending.delete(response.id)
      if ('error' in response) entry.reject(new DatabaseError(response.error.message, response.error.code, response.error.errcode))
      else entry.resolve(response.result)
    })
    const fail = (error: Error) => {
      this.failure = error
      for (const entry of this.pending.values()) entry.reject(error)
      this.pending.clear()
    }
    this.worker.on('error', fail)
    this.worker.on('exit', () => fail(new DatabaseError('La base de memoria se cerró')))
  }
  send<T = unknown>(request: Omit<EngineRequest, 'id'>): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ ...request, id })
    })
  }
  /** Runs `fn` with exclusive use of this connection; queued callers wait in order. */
  hold<T>(fn: () => Promise<T>): Promise<T> {
    this.waiting++
    const run = this.tail.then(fn, fn).finally(() => { this.waiting-- })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
  async close(): Promise<void> {
    if (!this.failure) await this.send({ op: 'close' }).catch(() => undefined)
    await this.worker.terminate()
  }
}

interface ActiveTransaction { db: MemoryDatabase; lane: Lane; sql: TransactionSql; closed: boolean; savepoints: number }
const activeTransaction = new AsyncLocalStorage<ActiveTransaction>()
const READ_ONLY = /^\s*(SELECT|WITH)\b/i
const WRITES = /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i

/**
 * SQLite memory database. Each connection lives in its own worker thread so long scans
 * (vector search, backups) never block the HTTP/MCP event loop. One writer connection serializes
 * writes; reads outside a transaction go to reader connections over the same WAL file.
 * Inside `transaction()`, every query issued through this database (directly or via `sql`)
 * joins that transaction, and nested `transaction()` calls become savepoints.
 */
export class MemoryDatabase implements Sql {
  readonly directory: string
  private writer: Lane | null = null
  private readers: Lane[] = []
  private lock: Lane | null = null
  private originalsTail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(readonly file: string, private readonly options: { readers?: number; busyTimeoutMs?: number } = {}) {
    this.directory = dirname(file)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    // SQLite creates files with the process umask and gives -wal/-shm the database's mode: start private.
    for (const path of [file, join(this.directory, 'memory.lock')]) {
      try { closeSync(openSync(path, 'wx', 0o600)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
  }

  private lane(role: EngineRole): Lane {
    if (this.closed) throw new DatabaseError('La base de memoria se cerró')
    const busy = this.options.busyTimeoutMs ?? 30_000
    if (role === 'writer') return this.writer ??= new Lane(this.file, 'writer', busy)
    if (role === 'lock') return this.lock ??= new Lane(join(this.directory, 'memory.lock'), 'lock', busy)
    // Readers open after the writer so the WAL file and schema already exist.
    this.lane('writer')
    if (this.readers.length < (this.options.readers ?? 2)) this.readers.push(new Lane(this.file, 'reader', busy))
    return this.readers.reduce((best, lane) => lane.waiting < best.waiting ? lane : best)
  }

  private current(): ActiveTransaction | undefined {
    const active = activeTransaction.getStore()
    return active && active.db === this && !active.closed ? active : undefined
  }

  async query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const active = this.current()
    if (active) return active.sql.query<T>(sql, params)
    const lane = READ_ONLY.test(sql) && !WRITES.test(sql) ? this.lane('reader') : this.lane('writer')
    return lane.hold(() => lane.send<T[]>({ op: 'query', sql, params }))
  }

  async transaction<T>(fn: (sql: TransactionSql) => Promise<T>, mode: 'write' | 'read' = 'write'): Promise<T> {
    const active = this.current()
    if (active) {
      const name = `sp${++active.savepoints}`
      await active.lane.send({ op: 'exec', sql: `SAVEPOINT ${name}` })
      try {
        const result = await fn(active.sql)
        await active.lane.send({ op: 'exec', sql: `RELEASE ${name}` })
        return result
      } catch (error) {
        await active.lane.send({ op: 'exec', sql: `ROLLBACK TO ${name}; RELEASE ${name}` }).catch(() => undefined)
        throw error
      }
    }
    const lane = this.lane(mode === 'write' ? 'writer' : 'reader')
    return lane.hold(async () => {
      const tx: ActiveTransaction = { db: this, lane, closed: false, savepoints: 0, sql: {
        query: <R>(sql: string, params: unknown[] = []) => lane.send<R[]>({ op: 'query', sql, params }),
        batches: <R>(sql: string, params: unknown[] = [], size = 128) => batches<R>(lane, sql, params, size),
        many: (sql: string, rows: unknown[][]) => lane.send<number>({ op: 'many', sql, rows }),
      } }
      await lane.send({ op: 'exec', sql: mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN' })
      try {
        const result = await activeTransaction.run(tx, () => fn(tx.sql))
        await lane.send({ op: 'exec', sql: 'COMMIT' })
        return result
      } catch (error) {
        await lane.send({ op: 'exec', sql: 'ROLLBACK' }).catch(() => undefined)
        throw error
      } finally { tx.closed = true }
    })
  }

  /** Runs statements outside any transaction on the writer connection (PRAGMAs, maintenance). */
  async execute(sql: string): Promise<void> {
    if (this.current()) throw new Error('execute no puede usarse dentro de una transacción')
    const lane = this.lane('writer')
    await lane.hold(() => lane.send({ op: 'exec', sql }))
  }

  async migrate(): Promise<void> {
    await this.transaction(async sql => {
      await sql.query('CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT (strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')))')
      const applied = new Set((await sql.query<{ version: number }>('SELECT version FROM schema_versions')).map(row => row.version))
      for (let i = 0; i < migrations.length; i++) {
        if (applied.has(i + 1)) continue
        await this.lane('writer').send({ op: 'exec', sql: migrations[i]! })
        await sql.query('INSERT INTO schema_versions(version) VALUES($1)', [i + 1])
      }
    })
  }

  /**
   * Serializes original-file IO with the database changes that reference it, across the HTTP and
   * worker processes. Must be entered before any transaction, never from inside one.
   */
  async withOriginals<T>(fn: () => Promise<T>): Promise<T> {
    if (this.current()) throw new Error('withOriginals no puede usarse dentro de una transacción')
    const previous = this.originalsTail
    let releaseTurn!: () => void
    this.originalsTail = new Promise<void>(resolve => { releaseTurn = resolve })
    await previous
    const lock = this.lane('lock')
    let acquired = false
    try {
      await lock.send({ op: 'lock' })
      acquired = true
      return await fn()
    } finally {
      if (acquired) await lock.send({ op: 'unlock' }).catch(() => undefined)
      releaseTurn()
    }
  }

  /** Consistent single-file copy of the live database (WAL included). */
  async snapshot(target: string): Promise<void> {
    const lane = this.lane('reader')
    // VACUUM INTO only reads the live database, but query_only rejects it as a write.
    await lane.hold(async () => {
      await lane.send({ op: 'exec', sql: 'PRAGMA query_only=OFF' })
      try { await lane.send({ op: 'query', sql: 'VACUUM INTO $1', params: [target] }) }
      finally { await lane.send({ op: 'exec', sql: 'PRAGMA query_only=ON' }) }
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const lanes = [...this.readers, this.writer, this.lock].filter((lane): lane is Lane => Boolean(lane))
    this.readers = []; this.writer = null; this.lock = null
    await Promise.all(lanes.map(lane => lane.close()))
  }
}

async function* batches<T>(lane: Lane, sql: string, params: unknown[], size: number): AsyncGenerator<T[]> {
  const cursor = await lane.send<number>({ op: 'cursor-open', sql, params })
  let done = false
  try {
    for (;;) {
      const rows = await lane.send<T[]>({ op: 'cursor-next', cursor, size })
      if (rows.length < size) done = true
      if (rows.length) yield rows
      if (done) return
    }
  } finally { if (!done) await lane.send({ op: 'cursor-close', cursor }).catch(() => undefined) }
}
