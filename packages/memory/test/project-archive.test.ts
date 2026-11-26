import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDatabase } from '../src/database.js'
import { exportMemory, readBackup, restoreMemory } from '../src/backup.js'
import { MemoryStore } from '../src/store.js'
import { MemoryOperations } from '../src/operations.js'
import { MemoryAI } from '../src/ai.js'
import { defaultAI, Vault } from '../src/config.js'
import { setProjectArchive } from '../src/projects/archive.js'
import { globalSearch } from '../src/projects/global-search.js'

describe('archivo local de proyectos', () => {
  let dir: string, db: MemoryDatabase, store: MemoryStore, ops: MemoryOperations, ai: MemoryAI
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hub-project-archive-'))
    db = new MemoryDatabase(join(dir, 'memory.sqlite'))
    await db.migrate()
    store = new MemoryStore(db, dir)
    const vault = new Vault(dir)
    ai = new MemoryAI(async () => defaultAI, vault)
    ops = new MemoryOperations(store, ai, undefined, vault)
  })
  afterEach(async () => { await db?.close(); if (dir) await rm(dir, { recursive: true, force: true }) })
  it('oculta por defecto, mantiene las escrituras, protege los fragmentos mixtos y recupera el mismo proyecto', async () => {
    const old = await store.create({ kind: 'project', title: 'Equipo saliente', data: { folders: ['/work/archive'], status: 'completed' } })
    const live = await store.create({ kind: 'project', title: 'Equipo actual' })
    const change = await setProjectArchive(store, old.id, { state: 'archived', version: 0 })
    expect(change).toMatchObject({ state: 'archived', version: 1 })
    expect(await setProjectArchive(store, old.id, { state: 'archived', version: 0 })).toEqual(change)
    await expect(setProjectArchive(store, old.id, { state: 'active', version: 0 })).rejects.toMatchObject({ statusCode: 409 })
    const source = await ops.call('import_source', { kind: 'meeting', title: 'Encuentro reservado', text: 'llegada posterior', project_ids: [old.id], external_id: 'reunion' }, 'mcp')
    await ops.call('create_entity', { kind: 'note', title: 'Nota posterior', data: { text: 'nota nueva' }, project_ids: [old.id] }, 'mcp')
    const mixed = await ops.call('import_source', { kind: 'document', metadata: { text: 'detalle reservado en bruto' }, title: 'Dos equipos', external_id: 'mixto', project_ids: [old.id, live.id],
      fragments: [{ text: 'detalle reservado', project_ids: [old.id] }, { text: 'detalle visible', project_ids: [live.id] }] }, 'mcp')
    const list = (extra: Record<string, unknown> = {}) => ops.call('list_entities', { kind: 'project', ...extra }, 'mcp')
    expect((await list()).items.map((p: any) => p.id)).toEqual([live.id])
    expect(await list({ project_state: 'archived' })).toMatchObject({ total: 1, items: [{ id: old.id, archive_version: 1 }] })
    await expect(ops.call('get_entity', { id: old.id }, 'mcp')).rejects.toMatchObject({ statusCode: 404 })
    expect((await ops.call('get_entity', { id: old.id, project_state: 'archived' }, 'mcp')).entity.id).toBe(old.id)
    expect(JSON.stringify(await ops.call('context', { path: '/work/archive/sub' }, 'mcp'))).not.toContain(old.id)
    expect((await ops.call('search', { query: 'detalle', mode: 'text' }, 'mcp')).items.map((f: any) => f.text)).toEqual(['detalle visible'])
    expect((await globalSearch(db, ai, { query: 'reservado' })).items).toHaveLength(0)
    await expect(ops.call('get_entity', { id: source.entity_id }, 'mcp')).rejects.toMatchObject({ statusCode: 404 })
    expect((await ops.call('get_entity', { id: source.entity_id })).entity.id).toBe(source.entity_id)
    expect(JSON.stringify(await ops.call('get_entity', { id: mixed.entity_id }, 'mcp'))).not.toContain('detalle reservado en bruto')
    expect(JSON.stringify(await ops.call('list_versions', { entity_id: mixed.entity_id }, 'mcp'))).not.toContain('detalle reservado en bruto')
    expect((await ops.call('get_entity', { id: source.entity_id, project_state: 'archived', archive_project_id: old.id }, 'mcp')).entity.id).toBe(source.entity_id)
    const collection = await store.create({ kind: 'collection', title: 'Reglas', data: { fields: [] } })
    for (const [name, projects] of [['solo archivo', [old.id]], ['compartida', [live.id,old.id]]] as const) {
      await ops.call('create_rule', { collection_id: collection.id, name, project_ids: projects, instructions: 'Revisar', enabled: false })
    }
    const rules = await ops.call('list_rules', {}, 'mcp')
    expect(rules.map((rule: any) => rule.name)).toEqual(['compartida'])
    expect(rules[0].project_ids).toEqual([live.id])
    await expect(ops.call('create_entity', { kind:'project',title:old.title }, 'mcp')).rejects.toThrow(/archivado/i)
    expect((await ops.call('search', { query: 'llegada', project_id: old.id, project_state: 'archived', mode: 'text' }, 'mcp')).total).toBe(1)
    expect(await setProjectArchive(store, old.id, { state: 'active', version: 1 })).toMatchObject({ state: 'active', version: 2 })
    expect((await list()).total).toBe(2)
    expect((await ops.call('get_entity', { id: old.id }, 'mcp')).entity.data.status).toBe('completed')
    expect((await ops.call('list_entities', { project_id: old.id }, 'mcp')).total).toBe(3)
  })
  it('conserva el estado en un respaldo y distingue un archivo anterior de una fusión', async () => {
    const tracked = await store.create({kind:'project',title:'Cuenta archivada'})
    const merged = await store.create({kind:'project',title:'Duplicado histórico'})
    await db.query("UPDATE entities SET data=json_set(data,'$.memory_state','archived','$.merged_into',$2) WHERE id=$1",[merged.id,tracked.id])
    await setProjectArchive(store, tracked.id, {state:'archived',version:0})
    const backup = JSON.parse(await readBackup(store, (await exportMemory(store)).id))
    for (const schema of [30,29,28]) {
      const path = join(dir,'restore-' + schema), restored = new MemoryDatabase(join(path,'memory.sqlite'))
      try {
        await restored.migrate()
        if (schema === 28) {
          backup.schema_version = schema
          delete backup.tables.project_archive_state
          backup.tables.entities.find((e: any) => e.id === tracked.id).data.memory_state = 'archived'
        }
        const other = new MemoryStore(restored,path)
        await restoreMemory(other,backup)
        const archived = await other.list({kind:'project',project_state:'archived'})
        expect(archived.items.map(e => e.id)).toEqual([tracked.id])
        await expect(setProjectArchive(other,merged.id,{state:'active',version:0})).rejects.toMatchObject({statusCode:409})
        expect(await setProjectArchive(other,tracked.id,{state:'active',version:1})).toMatchObject({state:'active',version:2})
      } finally { await restored.close() }
    }
  })
})
