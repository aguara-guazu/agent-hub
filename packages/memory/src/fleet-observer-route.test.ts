import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { registerMemory } from './routes.js'

it('allows the human owner activity route, rejects agent credentials and invalid cursors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-observer-route-'))
  const app = Fastify()
  const { service } = registerMemory(app, { directory, baseUrl: 'http://localhost', authorize: async request => {
    if (request.headers.authorization !== 'Bearer human-owner') throw Object.assign(new Error('Owner required'), { statusCode: 401 })
    return { id: 'owner' }
  } })
  const activity = vi.spyOn(service, 'fleetActivity').mockResolvedValue({ supported: true, generation: 'synthetic', state: 'busy', items: [{ seq: 1, at: '2026-01-01T00:00:00Z', kind: 'tool', text: 'synthetic output' }], next_cursor: 1 })
  try {
    const rejected = await app.inject({ url: '/api/memory/chat/agents/session/activity', headers: { authorization: 'Bearer agent-key' } })
    expect(rejected.statusCode).toBe(401)
    expect(activity).not.toHaveBeenCalled()
    const accepted = await app.inject({ url: '/api/memory/chat/agents/session/activity?after=2', headers: { authorization: 'Bearer human-owner' } })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.headers['cache-control']).toBe('no-store')
    expect(activity).toHaveBeenCalledWith('session', 2)
    expect(accepted.json().items[0].text).toBe('synthetic output')
    activity.mockClear()
    const invalid = await app.inject({ url: '/api/memory/chat/agents/session/activity?after=-1', headers: { authorization: 'Bearer human-owner' } })
    expect(invalid.statusCode).toBe(422)
    expect(activity).not.toHaveBeenCalled()
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

it('keeps coordinator selection and exact plan approval exclusively on owner routes',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'team-owner-routes-')),app=Fastify()
  const {service}=registerMemory(app,{directory,baseUrl:'http://localhost',worker:false,authorize:async request=>{
    if(request.headers.authorization!=='Bearer owner')throw Object.assign(new Error('Owner required'),{statusCode:401})
    return {id:'owner'}
  }})
  const remove=vi.fn(async()=>({affected_plans:[]})),restore=vi.fn(async()=>({channel:{}}))
  const approve=vi.fn(async()=>({state:'launched'})),designate=vi.fn(async()=>({affected_plans:[]})),stop=vi.fn(async()=>({uncertain_members:[]}))
  vi.spyOn(service,'get').mockResolvedValue({operations:{teams:{approveByHuman:approve,stopTransferredPlans:stop},chat:{designateCoordinator:designate,deleteChannel:remove,restoreChannel:restore}}} as any)
  const plan='11111111-1111-4111-8111-111111111111',digest='a'.repeat(64)
  try {
    for(const url of [`/api/memory/teams/${plan}/approve`,'/api/memory/chat/coordinator','/api/memory/chat/channels/delete','/api/memory/chat/channels/restore']) {
      const response=await app.inject({method:'POST',url,headers:{authorization:'Bearer agent'},payload:{digest}})
      expect(response.statusCode).toBe(401)
    }
    expect(approve).not.toHaveBeenCalled();expect(designate).not.toHaveBeenCalled()
    const response=await app.inject({method:'POST',url:`/api/memory/teams/${plan}/approve`,headers:{authorization:'Bearer owner'},payload:{digest}})
    expect(response.statusCode).toBe(200);expect(approve).toHaveBeenCalledWith(plan,digest,'owner')
    const input={channel_id:plan,participant_id:'native:participant',expected_leader_id:'native:previous'}
    expect((await app.inject({method:'POST',url:'/api/memory/chat/coordinator',headers:{authorization:'Bearer owner'},payload:input})).statusCode).toBe(200)
    expect(designate).toHaveBeenCalledWith(input,'owner');expect(stop).toHaveBeenCalledWith([])
    const deletion={channel_id:plan,reason:'Limpiar prueba'}
    expect((await app.inject({method:'POST',url:'/api/memory/chat/channels/delete',headers:{authorization:'Bearer owner'},payload:deletion})).statusCode).toBe(200)
    expect(remove).toHaveBeenCalledWith(deletion,{user_id:'owner'})
    expect((await app.inject({method:'POST',url:'/api/memory/chat/channels/restore',headers:{authorization:'Bearer owner'},payload:{channel_id:plan}})).statusCode).toBe(200)
    expect(restore).toHaveBeenCalledWith(plan)
  } finally {vi.restoreAllMocks();await app.close();await rm(directory,{recursive:true,force:true})}
})
