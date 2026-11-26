import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { ensureLocalOwner } from '../src/local.js'
import { createAccessToken } from '../src/security.js'

afterEach(() => vi.unstubAllEnvs())
it('conserva el archivo al reiniciar sin escritorio y lo filtra en el transporte MCP real y al alternar los módulos', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-archive-headless-')), memoryDir = join(root, 'memory')
  vi.stubEnv('AGENTHUB_MEMORY_DIR', memoryDir)
  vi.stubEnv('AGENTHUB_MEMORY_WORKER', '0')
  const start = () => buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(root, 'hub.db') } })
  let app = start(), client: Client | undefined
  try {
    const headers = { authorization: 'Bearer ' + await createAccessToken(app.settings, ensureLocalOwner(app.store).id) }
    const make = (title: string) => app.fastify.inject({ method: 'POST', url: '/api/memory/call', headers, payload: { operation: 'create_entity', input: { kind: 'project', title } } })
    const archived = (await make('Prueba de archivo')).json().id, active = (await make('Prueba vigente')).json().id
    const url = '/api/memory/projects/' + archived + '/archive'
    const put = (path: string, payload: Record<string, unknown>) => app.fastify.inject({ method:'PUT', url:path, headers, payload })
    expect((await app.fastify.inject({ method:'PUT', url, payload:{ state:'archived', version:0 } })).statusCode).toBe(401)
    expect((await put(url, { state:'archived', version:0 })).json()).toMatchObject({ version:1, state:'archived' })
    await app.fastify.close()
    app = start()
    const base = await app.fastify.listen({ host:'127.0.0.1', port:0 })
    client = new Client({ name:'archive-test', version:'1' })
    const token = await readFile(join(memoryDir,'secrets','memory-mcp'), 'utf8')
    await client.connect(new StreamableHTTPClientTransport(new URL('/api/memory/mcp',base), { requestInit: { headers: { authorization:token } } }))
    const list = async (archivedOnly = false) => {
      const result = await client!.callTool({ name:'list_entities', arguments:{ kind:'project', ...(archivedOnly ? { project_state:'archived' } : {}) } })
      expect(result.isError).not.toBe(true)
      return JSON.parse((result.content as { text:string }[])[0]!.text).items.map((i: { id:string }) => i.id)
    }
    expect(await list()).toEqual([active])
    expect(await list(true)).toEqual([archived])
    const note = await app.fastify.inject({method:'POST',url:'/api/memory/call',headers,payload:{operation:'create_entity',input:{kind:'note',title:'Llegó después del reinicio',project_ids:[archived]}}})
    expect(note.statusCode).toBe(200)
    const contents = async () => {
      const result = await client!.callTool({name:'get_entity',arguments:{id:note.json().id}})
      return result.isError ? null : JSON.parse((result.content as {text:string}[])[0]!.text).entity.title
    }
    expect(await contents()).toBeNull()
    const entry = (module: string) => {
      if (module === 'sharing') return app.fastify.inject({method:'POST',url:'/api/memory/sharing/call',headers,payload:{operation:'status'}})
      if (module === 'mcp') return app.fastify.inject({method:'POST',url:'/api/memory/mcp',headers:{authorization:token,accept:'application/json, text/event-stream'},payload:{jsonrpc:'2.0',id:1,method:'tools/list',params:{}}})
      const paths: Record<string,string> = { assistants:'/api/assistants/inbox', schedules:'/api/memory/schedules', connections:'/api/memory/jira-settings' }
      return module === 'memory' ? app.fastify.inject({method:'POST',url:'/api/memory/call',headers,payload:{operation:'list_entities',input:{kind:'project'}}})
        : app.fastify.inject({method:'GET',url:paths[module]!,headers})
    }
    for (const module of ['assistants','schedules','connections','sharing','mcp','memory']) {
      expect((await entry(module)).statusCode).toBe(200)
      expect((await put('/api/modules/'+module,{ enabled:false })).statusCode).toBe(200)
      expect((await app.fastify.inject({ method:'GET',url:'/api/catalog/skills',headers })).statusCode).toBe(200)
      if (module === 'memory') expect((await put(url,{ state:'active',version:1 })).statusCode).toBe(409)
      expect((await entry(module)).statusCode).toBe(409)
      expect((await put('/api/modules/'+module,{ enabled:true })).statusCode).toBe(200)
      expect((await entry(module)).statusCode).toBe(200)
      expect(await list()).toEqual([active])
    }
    expect((await put(url,{ state:'active',version:1 })).json()).toMatchObject({ version:2, state:'active' })
    expect(await contents()).toBe('Llegó después del reinicio')
    expect(await list(true)).toEqual([])
    expect(await list()).toEqual(expect.arrayContaining([active,archived]))
  } finally { await client?.close(); await app.fastify.close(); await rm(root,{force:true,recursive:true}) }
})
