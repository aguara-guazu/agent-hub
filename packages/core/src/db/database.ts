/**
 * Envoltura de `node:sqlite` (DatabaseSync).
 *
 * SQLite es la fuente local. La abrimos con claves foráneas activas (SQLite no las
 * aplica salvo que se lo pidan, y las pide por conexión) y en modo WAL para que un
 * lector no bloquee a un escritor durante el long poll de sincronización. Todos los
 * timestamps se guardan como texto ISO-8601 UTC y los documentos como JSON canónico.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite'

export type SqlValue = string | number | bigint | null | Uint8Array

export interface Row {
  [column: string]: SqlValue
}

/** Conexión a la base con helpers tipados sobre `node:sqlite`. */
export class Database {
  readonly handle: DatabaseSync

  constructor(path: string) {
    this.handle = new DatabaseSync(path)
    this.handle.exec('PRAGMA journal_mode = WAL')
    this.handle.exec('PRAGMA foreign_keys = ON')
    this.handle.exec('PRAGMA busy_timeout = 5000')
  }

  exec(sql: string): void {
    this.handle.exec(sql)
  }

  prepare(sql: string): StatementSync {
    return this.handle.prepare(sql)
  }

  /** Todas las filas de una consulta. */
  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.handle.prepare(sql).all(...params) as unknown as T[]
  }

  /** Primera fila, o `undefined`. */
  get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.handle.prepare(sql).get(...params) as unknown as T | undefined
  }

  /** Ejecuta una sentencia de escritura. */
  run(sql: string, ...params: SqlValue[]): void {
    this.handle.prepare(sql).run(...params)
  }

  /** Corre `fn` dentro de una transacción; revierte si lanza. */
  transaction<T>(fn: () => T): T {
    this.handle.exec('BEGIN')
    try {
      const result = fn()
      this.handle.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.handle.exec('ROLLBACK')
      } catch {
        // el rollback puede fallar si la transacción ya cerró; no ocultar el error real
      }
      throw error
    }
  }

  tableExists(name: string): boolean {
    const row = this.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      name,
    )
    return row !== undefined
  }

  close(): void {
    this.handle.close()
  }
}
