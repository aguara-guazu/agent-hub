import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Database } from '../src/db/database.js'
import { MIGRATIONS, runMigrations } from '../src/db/migrations.js'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agenthub-mig-'))
  path = join(dir, 'agenthub.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('migraciones', () => {
  it('crea el esquema completo y registra su version', () => {
    const db = new Database(path)
    const outcome = runMigrations(db, path)
    expect(outcome.applied).toEqual(MIGRATIONS.map((m) => m.id))
    expect(db.tableExists('mcp_servers')).toBe(true)
    expect(db.tableExists('exposure_rules')).toBe(true)
    expect(db.tableExists('schema_migrations')).toBe(true)
    const rows = db.all('SELECT id FROM schema_migrations')
    expect(rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id))
    db.close()
  })

  it('es idempotente: una segunda corrida no aplica nada', () => {
    const db = new Database(path)
    runMigrations(db, path)
    const second = runMigrations(db, path)
    expect(second.applied).toEqual([])
    db.close()
  })

  it('reconoce un esquema legado sin recrearlo, y respalda antes de tocar', () => {
    // Simula una base anterior sin schema_migrations.
    const db = new Database(path)
    db.exec('CREATE TABLE organizations (id TEXT PRIMARY KEY, slug TEXT, name TEXT, created_at TEXT, updated_at TEXT)')
    db.exec("CREATE TABLE alembic_version (version_num TEXT NOT NULL)")
    db.exec("INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES ('o1', 'craftech', 'Craftech', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')")

    const outcome = runMigrations(db, path)
    expect(outcome.recognizedExisting).toBe(true)
    // Hizo copia de seguridad porque había datos en disco antes de aplicar el esquema.
    expect(outcome.backupPath).not.toBeNull()
    expect(existsSync(outcome.backupPath!)).toBe(true)
    // Conserva intacto el marcador histórico y registra la migración actual.
    const org = db.get<{ name: string }>('SELECT name FROM organizations WHERE slug = ?', 'craftech')
    expect(org?.name).toBe('Craftech')
    // El resto de tablas del esquema TypeScript sí se crearon.
    expect(db.tableExists('mcp_tools')).toBe(true)
    db.close()
  })
})
