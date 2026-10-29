import { afterEach, beforeEach, expect, it } from 'vitest'
import { Database } from '../src/db/database.js'
import { runMigrations } from '../src/db/migrations.js'
import { Store } from '../src/store.js'
import { ensureLocalOwner } from '../src/local.js'
import { JIRA_SERVER_SETTING, readJiraServerId } from '../src/effects/jira-server.js'

let db: Database, store: Store, ownerId: string
const base = { description: '', transport: 'http' as const, command: '', args: [], env: {}, cwd: '', url: 'https://mcp.atlassian.com/v1/mcp', headers: {}, secret_refs: {}, requires_host_access: false,
  container_image: '', allow_hosts: [], allow_ports: [], read_mounts: [], write_mounts: [], auth: 'none' as const }
beforeEach(() => { db = new Database(':memory:'); runMigrations(db, ':memory:'); store = new Store(db); ownerId = ensureLocalOwner(store).id })
afterEach(() => db.close())

it('sin setting no hay servidor de Jira', () => {
  expect(readJiraServerId(store, ownerId)).toBeUndefined()
  store.setSetting(JIRA_SERVER_SETTING, '   ')
  expect(readJiraServerId(store, ownerId)).toBeUndefined()
})

it('devuelve el id del servidor del dueño y refleja cambios sin reiniciar', () => {
  const first = store.insertServer({ ...base, user_id: ownerId, slug: 'atlassian_rovo', display_name: 'A' })
  const second = store.insertServer({ ...base, user_id: ownerId, slug: 'atlassian_rovo_2', display_name: 'B' })
  store.setSetting(JIRA_SERVER_SETTING, first.id)
  expect(readJiraServerId(store, ownerId)).toBe(first.id)
  store.setSetting(JIRA_SERVER_SETTING, second.id)
  expect(readJiraServerId(store, ownerId)).toBe(second.id)
})

it('un id inexistente, un slug o el servidor de otro dueño fallan cerrados', () => {
  const org = store.insertOrganization('otra', 'Otra')
  const other = store.insertUser({ organization_id: org.id, email: 'otro@example.com', full_name: 'Otro', password_hash: '!', org_role: 'owner' })
  const foreign = store.insertServer({ ...base, user_id: other.id, slug: 'ajeno', display_name: 'Ajeno' })
  store.insertServer({ ...base, user_id: ownerId, slug: 'atlassian_rovo', display_name: 'A' })
  for (const value of ['no-existe', 'atlassian_rovo', foreign.id]) {
    store.setSetting(JIRA_SERVER_SETTING, value)
    expect(readJiraServerId(store, ownerId)).toBeUndefined()
  }
})
