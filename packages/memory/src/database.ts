import pg from 'pg'
import type { PoolClient } from 'pg'
import { migrations } from './migrations.js'

// Serialize dates identically across HTTP, MCP, fixtures and backups.
pg.types.setTypeParser(1184, value => new Date(value).toISOString())
export interface Sql {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>
}
export class MemoryDatabase implements Sql {
  readonly pool: pg.Pool
  private originalsTail: Promise<void> = Promise.resolve()
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 6, connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10_000, statement_timeout: 30_000,
      options: '-c search_path=agenthub_memory,public', application_name: 'agenthub-memory' })
    this.pool.on('error', () => { /* The next operation reports a sanitized availability error. */ })
  }
  async query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows as T[]
  }
  async transaction<T>(fn: (sql: Sql) => Promise<T>, isolation = ''): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query(`BEGIN ${isolation}`)
      const result = await fn(clientSql(client))
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { client.release() }
  }
  async migrate(): Promise<void> {
    await this.transaction(async sql => {
      await sql.query("SELECT pg_advisory_xact_lock(70420260913)")
      await sql.query('CREATE SCHEMA IF NOT EXISTS agenthub_memory')
      await sql.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public')
      await sql.query('CREATE TABLE IF NOT EXISTS schema_versions (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
      for (let i = 0; i < migrations.length; i++) {
        if (!(await sql.query('SELECT version FROM schema_versions WHERE version=$1', [i + 1])).length) {
          await sql.query(migrations[i]!)
          await sql.query('INSERT INTO schema_versions(version) VALUES($1)', [i + 1])
        }
      }
    })
  }
  // A session lock spans both the DB commit and original-file IO, across UI and worker processes.
  // Backups acquire it before opening their snapshot, so a concurrent deletion cannot remove a referenced original.
  async withOriginals<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.originalsTail
    let releaseTurn!: () => void
    this.originalsTail = new Promise<void>(resolve => { releaseTurn = resolve })
    await previous
    let client: PoolClient | undefined
    try {
      client = await this.pool.connect()
      await client.query('SELECT pg_advisory_lock(70420260914)')
      return await fn()
    } finally {
      if (client) {
        await client.query('SELECT pg_advisory_unlock(70420260914)').catch(() => undefined)
        client.release()
      }
      releaseTurn()
    }
  }
  async close(): Promise<void> { await this.pool.end() }
}
function clientSql(client: PoolClient): Sql {
  return { query: async <T>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[] }
}
