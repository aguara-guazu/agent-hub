import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../src/db/database.js'
import { runMigrations } from '../src/db/migrations.js'
import { Store } from '../src/store.js'
import { record, verify } from '../src/audit/ledger.js'

let dir: string
let db: Database
let store: Store
let orgId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agenthub-audit-'))
  db = new Database(join(dir, 'agenthub.db'))
  runMigrations(db, join(dir, 'agenthub.db'))
  store = new Store(db)
  orgId = store.insertOrganization('craftech', 'Craftech').id
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ledger', () => {
  it('encadena eventos y verify da ok', () => {
    record(store, orgId, 'sistema', 'a')
    record(store, orgId, 'sistema', 'b')
    record(store, orgId, 'sistema', 'c')
    expect(verify(store, orgId)).toEqual({ ok: true, brokenAt: null })
  })

  it('timestamps estrictamente crecientes aunque el reloj no avance', () => {
    const first = record(store, orgId, 'sistema', 'a')
    const second = record(store, orgId, 'sistema', 'b')
    expect(Date.parse(second.created_at)).toBeGreaterThan(Date.parse(first.created_at))
  })

  it('verify detecta una fila manipulada', () => {
    record(store, orgId, 'sistema', 'a')
    const target = record(store, orgId, 'sistema', 'b')
    record(store, orgId, 'sistema', 'c')
    // Manipulación directa a la base: cambiar la acción sin recalcular el hash.
    db.run('UPDATE audit_events SET action = ? WHERE id = ?', 'MANIPULADO', target.id)
    const result = verify(store, orgId)
    expect(result.ok).toBe(false)
    expect(result.brokenAt).toBe(target.id)
  })
})
