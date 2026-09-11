import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp, type CoreApp } from '../src/app.js'
import { STARTER_CATALOG_SETTING, STARTER_SERVERS, applyStarterCatalog } from '../src/catalog/starter.js'
import { ensureLocalOwner } from '../src/local.js'

const dirs: string[] = []
const apps: CoreApp[] = []
afterEach(() => {
  for (const app of apps.splice(0)) app.db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function open(databasePath: string, starterCatalog: boolean): CoreApp {
  const app = buildApp({ settings: { databasePath, starterCatalog, localMode: true }, ensureOwner: true })
  apps.push(app)
  return app
}
function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-starter-'))
  dirs.push(dir)
  return join(dir, 'hub.db')
}

describe('catálogo inicial', () => {
  it('la lista de fábrica es sólo de servers http públicos con OAuth y slugs únicos', () => {
    expect(STARTER_SERVERS.length).toBeGreaterThan(0)
    expect(new Set(STARTER_SERVERS.map((s) => s.slug)).size).toBe(STARTER_SERVERS.length)
    for (const server of STARTER_SERVERS) {
      expect(server.url).toMatch(/^https:\/\//)
      expect(server.slug).toMatch(/^[a-z][a-z0-9_-]{1,47}$/)
      expect(server.description).toContain('Requiere autorizar')
    }
  })

  it('en el primer arranque local siembra la base, habilitada y a la espera de autorizar', () => {
    const db = freshDb()
    const app = open(db, true)
    const owner = ensureLocalOwner(app.store)
    const servers = app.store.serversOfUser(owner.id)
    expect(servers.map((s) => s.slug).sort()).toEqual([...STARTER_SERVERS.map((s) => s.slug)].sort())
    for (const server of servers) {
      expect(server.transport).toBe('http')
      expect(server.auth).toBe('oauth')
      expect(server.last_probe_error).toBe('')
      expect(app.store.findRule(owner.id, null, 'mcp_server', server.id)).toBeUndefined()
    }
    expect(app.store.setting(STARTER_CATALOG_SETTING)).toBe('1')
  })

  it('no duplica al volver a arrancar ni repone lo que la persona borró', () => {
    const db = freshDb()
    const first = open(db, true)
    const owner = ensureLocalOwner(first.store)
    const notion = first.store.serverBySlug(owner.id, 'notion')!
    first.store.deleteServer(notion.id)
    first.db.close()
    apps.splice(apps.indexOf(first), 1)

    const second = open(db, true)
    const slugs = second.store.serversOfUser(owner.id).map((s) => s.slug)
    expect(slugs).not.toContain('notion')
    expect(slugs).toHaveLength(STARTER_SERVERS.length - 1)
  })

  it('respeta lo que ya existía con el mismo slug y se puede desactivar', () => {
    const db = freshDb()
    const disabled = open(db, false)
    const owner = ensureLocalOwner(disabled.store)
    expect(disabled.store.serversOfUser(owner.id)).toEqual([])
    disabled.store.insertServer({
      user_id: owner.id, slug: 'notion', display_name: 'Mi Notion', description: '', transport: 'http', command: '', args: [], env: {}, cwd: '',
      url: 'https://mcp.notion.com/mcp', headers: {}, secret_refs: {}, requires_host_access: false, container_image: '', allow_hosts: [], allow_ports: [], read_mounts: [], write_mounts: [],
    })
    const outcome = applyStarterCatalog(disabled.store, owner)
    expect(outcome.skipped).toEqual(['notion'])
    expect(outcome.added).toHaveLength(STARTER_SERVERS.length - 1)
    expect(disabled.store.serverBySlug(owner.id, 'notion')!.display_name).toBe('Mi Notion')
    expect(applyStarterCatalog(disabled.store, owner).alreadyApplied).toBe(true)
  })
})
