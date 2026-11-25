import { expect, it } from 'vitest'
import { makeApp, authHeader } from './helpers.js'
import { ensureLocalOwner } from '../src/local.js'
import { generateDaemonToken } from '../src/security.js'
import { moduleDefinition } from '@agenthub/shared/modules'

it('conserva el catálogo de la máquina mientras Skills está apagado y lo reconcilia al reactivarlo', async () => {
  const app = makeApp({ localMode: false, starterCatalog: false })
  try {
    const owner = ensureLocalOwner(app.store)
    const machine = app.store.insertMachine({ user_id: owner.id, hostname: 'desktop', os: 'test', daemon_version: 'test' })
    const [token, hash] = generateDaemonToken()
    app.store.insertToken({ user_id: owner.id, machine_id: machine.id, name: 'daemon', token_hash: hash })
    const url = '/api/sync/external-skills'
    const sync = (skills: object[]) => app.fastify.inject({ method: 'PUT', url, headers: authHeader(token), payload: { skills } })
    const skill = { slug: 'ejemplo', tree_hash: 'hash-1', source_path: '/skills/ejemplo' }
    expect((await app.fastify.inject({ method: 'PUT', url, payload: { skills: [skill] } })).statusCode).toBe(401)
    expect((await sync([skill])).json()).toMatchObject({ created: ['ejemplo'] })
    app.store.setSetting(moduleDefinition('skills').setting, '0')
    expect((await sync([])).json()).toMatchObject({ code: 'module_disabled', module: 'skills' })
    expect(app.store.externalSkillsOfMachine(owner.id, machine.id).map(item => item.slug)).toEqual(['ejemplo'])
    app.store.setSetting(moduleDefinition('skills').setting, '1')
    expect((await sync([{ ...skill, tree_hash: 'hash-2' }])).json()).toMatchObject({ updated: ['ejemplo'] })
    expect((await sync([])).json()).toMatchObject({ removed: ['ejemplo'] })
  } finally {
    await app.fastify.close()
    app.cleanup()
  }
})
