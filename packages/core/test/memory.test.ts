import { applyProbeResult } from '../src/catalog/reconcile.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ConnectionPool, RemoteHttpRuntime, GatewayServer, PolicyStore } from '@agenthub/gateway'
import { buildApp, type CoreApp } from '../src/app.js'
import { ensureLocalOwner } from '../src/local.js'
import { explain, computeSnapshot } from '../src/policy/resolver.js'
import { createAccessToken, generateDaemonToken } from '../src/security.js'

describe('memoria HTTP y gateway MCP', () => {
  let app: CoreApp, directory: string, token: string, owner: ReturnType<typeof ensureLocalOwner>
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'memory-core-'))
    vi.stubEnv('AGENTHUB_MEMORY_DIR', join(directory, 'memory'))
    vi.stubEnv('AGENTHUB_MEMORY_WORKER', '0')
    app = buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(directory, 'hub.db') } })
    owner = ensureLocalOwner(app.store)
    token = await createAccessToken(app.settings, owner.id)
  })
  afterEach(async () => { await app?.fastify.close(); app?.db.close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs() })
  it('apaga y restaura colaboración sin alterar memoria ni reglas y persiste al reiniciar', async () => {
    const headers = { authorization: `Bearer ${token}` }, url = '/api/collaboration'
    expect((await app.fastify.inject({ method: 'GET', url })).statusCode).toBe(401)
    expect((await app.fastify.inject({ method: 'PUT', url, payload: { enabled: false } })).statusCode).toBe(401)
    expect((await app.fastify.inject({ method: 'GET', url, headers })).json()).toEqual({ enabled: true })
    expect((await app.fastify.inject({ method: 'PUT', url, headers, payload: { enabled: 'false' } })).statusCode).toBe(422)
    const machine = app.store.insertMachine({ user_id: owner.id, hostname: 'collaboration', os: 'test', daemon_version: 'test' })
    const agent = app.store.insertAgent({ machine_id: machine.id, cli_kind: 'codex_cli', cli_version: 'test', config_path: '' })
    const before = computeSnapshot(app.store, agent.id)
    const chat = before.servers.flatMap(s => s.tools).find(t => t.name === 'chat_join')!
    const inbox = before.servers.flatMap(s => s.tools).find(t => t.name === 'chat_inbox')!
    app.store.insertRule({ user_id: owner.id, agent_instance_id: agent.id, resource_type: 'mcp_tool', resource_id: chat.id, state: 'on', reason: 'personal allow' })
    app.store.insertRule({ user_id: owner.id, agent_instance_id: null, resource_type: 'mcp_tool', resource_id: inbox.id, state: 'off', reason: 'personal deny' })
    const rules = app.store.userRules(owner.id), clientRules = app.store.clientRules(agent.id)
    const set = (enabled: boolean) => app.fastify.inject({ method: 'PUT', url, headers, payload: { enabled } })
    expect((await set(false)).json()).toEqual({ enabled: false })
    const off = computeSnapshot(app.store, agent.id)
    expect(off.servers.flatMap(s => s.tools).some(t => /^(chat_|team_)/.test(t.name))).toBe(false)
    expect(off.skills.map(s => s.slug)).toContain('memory')
    expect(off.skills.map(s => s.slug)).not.toContain('local-collaboration')
    expect(off.skills.map(s => s.slug)).not.toContain('hub-collaboration')
    expect(explain(app.store, agent.id, 'mcp_tool', chat.id).source).toBe('collaboration_disabled')
    const bundled = app.store.serverBySlug(owner.id, 'memory')!
    const discovered = off.servers.find(s => s.id === bundled.id)!.tools
    applyProbeResult(app.store, bundled, { ok: true, error: '', auth_required: false, server_name: 'agenthub-memory', server_version: '0.2.0',
      tools: discovered.map(t => ({ name: t.name, title: t.title, description: t.description, input_schema: t.input_schema })) })
    expect(app.store.tool(chat.id)!.quarantined).toBe(false)

    for (const operation of ['chat_join', 'team_create', 'send_message', 'read_messages', 'claim_work']) {
      expect((await app.fastify.inject({ method: 'POST', url: '/api/memory/call', headers, payload: { operation, input: {} } })).statusCode).toBe(403)
    }
    expect((await app.fastify.inject({ method: 'POST', url: '/api/memory/call', headers, payload: { operation: 'skill_reference', input: { section: 'local-collaboration' } } })).statusCode).toBe(403)
    expect((await app.fastify.inject({ method: 'POST', url: '/api/memory/call', headers, payload: { operation: 'create_entity', input: { kind: 'project', title: 'Memory remains' } } })).statusCode).toBe(200)
    const base = await app.fastify.listen({ host: '127.0.0.1', port: 0 })
    const direct = new Client({ name: 'collaboration-toggle-test', version: '1' })
    try {
      await direct.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/memory/mcp`), {
        requestInit: { headers: { authorization: readFileSync(join(directory, 'memory/secrets/memory-mcp'), 'utf8') } },
      }))
      expect((await direct.listTools()).tools.some(t => /^(chat_|team_)/.test(t.name))).toBe(false)
      const denied = await direct.callTool({ name: 'chat_join', arguments: {} })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('desactivada')
      await set(true)
      expect((await direct.listTools()).tools.some(t => t.name === 'chat_join')).toBe(true)
      await set(false)
    } finally { await direct.close() }
    const native = await app.fastify.inject({ method: 'POST', url: '/api/memory/chat/native', headers, payload: { agent_id: agent.id, native_id: 'test', session_key: 'k'.repeat(64), cwd: directory, at: new Date().toISOString(), event: 'Heartbeat' } })
    expect(native.statusCode).toBe(403)
    await app.fastify.close(); app.db.close()
    app = buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(directory, 'hub.db') } })
    expect((await app.fastify.inject({ method: 'GET', url, headers })).json()).toEqual({ enabled: false })
    expect((await set(true)).json()).toEqual({ enabled: true })
    const restored = computeSnapshot(app.store, agent.id)
    expect(restored.servers.flatMap(s => s.tools).some(t => t.id === chat.id)).toBe(true)
    expect(restored.servers.flatMap(s => s.tools).some(t => t.id === inbox.id)).toBe(false)
    expect(restored.skills.map(s => s.slug)).toContain('local-collaboration')
    expect(app.store.userRules(owner.id)).toEqual(rules)
    expect(app.store.clientRules(agent.id)).toEqual(clientRules)
    expect((await app.fastify.inject({ method: 'POST', url: '/api/memory/call', headers, payload: { operation: 'skill_reference', input: { section: 'local-collaboration' } } })).statusCode).toBe(200)
  })
  it('exige sesión local y no entrega credenciales al consultar configuración', async () => {
    const denied = await app.fastify.inject({ method: 'GET', url: '/api/memory/status' })
    expect(denied.statusCode).toBe(401)
    expect((await app.fastify.inject({ method: 'POST', url: '/api/memory/search', payload: { query: 'privado' } })).statusCode).toBe(401)
    expect((await app.fastify.inject({ method: 'POST', url: '/api/memory/sharing/call', payload: { operation: 'status' } })).statusCode).toBe(401)
    expect((await app.fastify.inject({ method: 'GET', url: '/api/memory/opencode' })).statusCode).toBe(401)
    expect((await app.fastify.inject({ method: 'POST', url: '/api/memory/opencode/test', payload: { model: 'opencode/big-pickle' } })).statusCode).toBe(401)
    const saved = await app.fastify.inject({ method: 'PUT', url: '/api/memory/credentials/deepseek', headers: { authorization: `Bearer ${token}` }, payload: { api_key: 'private-mcp-key' } })
    expect(saved.statusCode).toBe(200)
    const status = await app.fastify.inject({ method: 'GET', url: '/api/memory/status', headers: { authorization: `Bearer ${token}` } })
    expect(status.json().ready).toBe(true); expect(status.json().deepseek_configured).toBe(true)
    expect(status.body).not.toContain('private-mcp-key')
    const invalid = await app.fastify.inject({ method: 'POST', url: '/api/memory/call', headers: { authorization: `Bearer ${token}` }, payload: { operation: 'create_entity', input: { kind: 'project', title: '' } } })
    expect(invalid.statusCode).toBe(422)
    const credentialDenied = await app.fastify.inject({ method: 'POST', url: '/api/memory/mcp', headers: { authorization: `Bearer ${token}` }, payload: {} })
    expect(credentialDenied.statusCode).toBe(401)
  })
  it('guarda, reemplaza y elimina la clave de Kiro sin exponerla a respuestas ni sesiones anónimas', async () => {
    vi.stubEnv('KIRO_API_KEY', '')
    const url = '/api/memory/credentials/kiro', headers = { authorization: `Bearer ${token}` }
    for (const method of ['GET', 'PUT', 'DELETE'] as const)
      expect((await app.fastify.inject({ method, url, ...(method === 'PUT' ? { payload: { api_key: 'private-key' } } : {}) })).statusCode).toBe(401)
    expect((await app.fastify.inject({ method: 'GET', url, headers })).json()).toEqual({ configured: false, stored: false })
    for (const api_key of ['ksk_private_first', 'ksk_private_replacement']) {
      const saved = await app.fastify.inject({ method: 'PUT', url, headers, payload: { api_key: ` ${api_key} ` } })
      expect(saved.statusCode).toBe(200); expect(saved.body).not.toContain(api_key)
      const status = await app.fastify.inject({ method: 'GET', url, headers })
      expect(status.json()).toEqual({ configured: true, stored: true })
      expect(status.headers['cache-control']).toBe('no-store'); expect(status.body).not.toContain(api_key)
      const path = join(directory, 'memory/secrets/kiro.json')
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ api_key })
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
      expect((await app.fastify.inject({ method: 'GET', url: '/api/memory/status', headers })).body).not.toContain(api_key)
    }
    expect((await app.fastify.inject({ method: 'PUT', url, headers, payload: { api_key: '  ' } })).statusCode).toBe(422)
    expect((await app.fastify.inject({ method: 'DELETE', url, headers })).statusCode).toBe(204)
    expect(existsSync(join(directory, 'memory/secrets/kiro.json'))).toBe(false)
    vi.stubEnv('KIRO_API_KEY', 'ksk_environment_secret')
    const status = await app.fastify.inject({ method: 'GET', url, headers })
    expect(status.json()).toEqual({ configured: true, stored: false })
    expect(status.body).not.toContain('ksk_environment_secret')
  })
  it('instala la skill de memoria de fábrica para todos los clientes, la actualiza con la app y respeta ediciones y borrados', async () => {
    const skills = await app.fastify.inject({ method: 'GET', url: '/api/catalog/skills', headers: { authorization: `Bearer ${token}` } })
    const skill = skills.json().find((s: any) => s.slug === 'memory')
    expect(skill).toBeTruthy()
    expect(skill.body).toContain('memory_search'); expect(skill.body).toContain('memory_review_duplicate'); expect(skill.body).not.toMatch(/^---/)
    const machine = app.store.insertMachine({ user_id: owner.id, hostname: 'skill-test', os: 'test', daemon_version: 'test' })
    const agent = app.store.insertAgent({ machine_id: machine.id, cli_kind: 'kiro', cli_version: 'test', config_path: '' })
    expect(computeSnapshot(app.store, agent.id).skills.map(s => s.slug).sort()).toEqual(['google-setup', 'hub-collaboration', 'local-collaboration', 'memory'])
    // A newer app ships a different body: it replaces the untouched copy and bumps the version.
    app.store.updateSkill(skill.id, { body: 'cuerpo de una versión anterior', content_hash: 'hash-anterior' })
    app.store.setSetting('memory_skill_hash', 'hash-anterior')
    await app.fastify.close(); app.db.close()
    app = buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(directory, 'hub.db') } })
    const updated = app.store.skill(skill.id)!
    expect(updated.version).toBe(2); expect(updated.body).toContain('memory_search')
    // A personal edit survives restarts, and a deletion is final.
    const edited = await app.fastify.inject({ method: 'PATCH', url: `/api/catalog/skills/${skill.id}`, headers: { authorization: `Bearer ${token}` }, payload: { body: 'Mis propias instrucciones' } })
    expect(edited.statusCode).toBe(200)
    await app.fastify.close(); app.db.close()
    app = buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(directory, 'hub.db') } })
    expect(app.store.skill(skill.id)!.body).toBe('Mis propias instrucciones')
    await app.fastify.inject({ method: 'DELETE', url: `/api/catalog/skills/${skill.id}`, headers: { authorization: `Bearer ${token}` } })
    await app.fastify.close(); app.db.close()
    app = buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(directory, 'hub.db') } })
    expect(app.store.skillsOfUser(owner.id).some(s => s.slug === 'memory')).toBe(false)
  })

  it('crea un proyecto por MCP real y apagar la tool bloquea la llamada siguiente en la misma sesión', async () => {
    const base = await app.fastify.listen({ host: '127.0.0.1', port: 0 })
    const server = app.store.serverBySlug(owner.id, 'memory')!
    app.store.updateServer(server.id, { url: `${base}/api/memory/mcp` })
    const machine = app.store.insertMachine({ user_id: owner.id, hostname: 'memory-test', os: 'test', daemon_version: 'test' })
    const agent = app.store.insertAgent({ machine_id: machine.id, cli_kind: 'claude_code', cli_version: 'test', config_path: '' })
    const policy = new PolicyStore(agent.id)
    policy.apply(computeSnapshot(app.store, agent.id))
    const pool = new ConnectionPool({ http: new RemoteHttpRuntime() })
    const gateway = new GatewayServer(agent.id, policy, pool)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'memory-test', version: '1' })
    try {
      await Promise.all([gateway.connect(serverTransport), client.connect(clientTransport)])
      const tools = (await client.listTools()).tools
      const createName = tools.find(t => t.name.endsWith('create_entity'))!.name
      const result = await client.callTool({ name: createName, arguments: { kind: 'project', title: 'Proyecto creado por MCP' } })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      const data = JSON.parse((result.content as { text: string }[])[0]!.text)
      expect(data.kind).toBe('project')
      const imported = await client.callTool({ name: tools.find(t => t.name.endsWith('import_file'))!.name,
        arguments: { title: 'Captura del proyecto', filename: 'capture.png', data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv1sAAAAASUVORK5CYII=', project_ids: [data.id] } })
      expect(imported.isError, JSON.stringify(imported)).not.toBe(true)
      const file = JSON.parse((imported.content as { text: string }[])[0]!.text)
      const shared = await app.fastify.inject({ method: 'POST', url: '/api/memory/sharing/call', headers: { authorization: `Bearer ${token}` }, payload: { operation: 'create', project_id: data.id } })
      expect(shared.statusCode).toBe(200); expect(shared.json().recovery_phrase.split(' ')).toHaveLength(24)
      expect(shared.headers['cache-control']).toBe('no-store')
      expect(tools.some(t => /recover|recovery|sharing_create/.test(t.name))).toBe(false)
      const revealPayload = { operation: 'recovery_phrase', project_id: data.id }
      expect((await app.fastify.inject({ method: 'POST', url: '/api/memory/sharing/call', payload: revealPayload })).statusCode).toBe(401)
      const revealed = await app.fastify.inject({ method: 'POST', url: '/api/memory/sharing/call', headers: { authorization: `Bearer ${token}` }, payload: revealPayload })
      expect(revealed.statusCode).toBe(200)
      expect(revealed.headers['cache-control']).toBe('no-store')
      expect(revealed.json().recovery_phrase).toBe(shared.json().recovery_phrase)
      const ordinaryStatus = await app.fastify.inject({ method: 'POST', url: '/api/memory/sharing/call', headers: { authorization: `Bearer ${token}` }, payload: { operation: 'status' } })
      expect(ordinaryStatus.body).not.toContain(shared.json().recovery_phrase)
      const humanMessage = await app.fastify.inject({ method: 'POST', url: '/api/memory/call', headers: { authorization: `Bearer ${token}` }, payload: {
        operation: 'send_message', input: { project_id: data.id, text: 'Aviso pendiente para el agente', expires_at: new Date(Date.now() + 60_000).toISOString() },
      } })
      expect(humanMessage.statusCode).toBe(403)
      const forumAuthor = new Client({ name: 'forum-author-test', version: '1' })
      try {
        await forumAuthor.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/memory/mcp`), {
          requestInit: { headers: { authorization: readFileSync(join(directory, 'memory/secrets/memory-mcp'), 'utf8') } },
        }))
        const agentMessage = await forumAuthor.callTool({ name: 'send_message',
          arguments: { project_id: data.id, text: 'Aviso pendiente para el agente', expires_at: new Date(Date.now() + 60_000).toISOString() },
          _meta: { 'agenthub/agent': { agent_id: 'forum-author', cli_kind: 'claude_code', client: 'test', session_id: 'session-forum-author', cwd: null } } })
        expect(agentMessage.isError).not.toBe(true)
      } finally { await forumAuthor.close() }
      const image = await client.callTool({ name: tools.find(t => t.name.endsWith('get_file'))!.name, arguments: { version_id: file.version_id, include_content: true } })
      expect(image.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', mimeType: 'image/png' })]))
      const notice = (image.content as { text?: string }[]).find(c => c.text?.includes('collaboration_notice'))
      expect(notice?.text).toContain('memory_read_messages'); expect(notice?.text).not.toContain('Aviso pendiente para el agente')
      const read = await client.callTool({ name: tools.find(t => t.name.endsWith('read_messages'))!.name, arguments: { project_id: data.id, unread_only: true } })
      expect(read.isError).not.toBe(true)
      expect(JSON.parse((read.content as { text: string }[])[0]!.text).items[0].text).toBe('Aviso pendiente para el agente')
      expect((await app.fastify.inject({ method: 'GET', url: file.download_url })).statusCode).toBe(401)
      const download = await app.fastify.inject({ method: 'GET', url: file.download_url, headers: { authorization: `Bearer ${token}` } })
      expect(download.statusCode).toBe(200); expect(download.headers['content-type']).toBe('image/png')
      expect(download.headers['content-disposition']).toContain('attachment;')
      expect(download.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]))
      const tool = app.store.toolsOfServer(server.id).find(t => t.name === 'create_entity')!
      const disabled = await app.fastify.inject({ method: 'PUT', url: '/api/policy/rules', headers: { authorization: `Bearer ${token}` }, payload: { scope: 'user', resource_type: 'mcp_tool', resource_id: tool.id, state: 'off' } })
      expect(disabled.statusCode).toBe(204)
      policy.apply(computeSnapshot(app.store, agent.id))
      const denied = await client.callTool({ name: createName, arguments: { kind: 'project', title: 'No debe crearse' } })
      expect(denied.isError).toBe(true)
      const list = await app.fastify.inject({ method: 'POST', url: '/api/memory/call', headers: { authorization: `Bearer ${token}` }, payload: { operation: 'list_entities', input: { kind: 'project', query: 'No debe crearse' } } })
      expect(list.json().total).toBe(0)
    } finally { await client.close(); await gateway.close(); await pool.close() }
  }, 20_000)
  it('cuotas nativas autentican la máquina y respetan OFF sin apagar el chat',async()=>{
    const machine=app.store.insertMachine({user_id:owner.id,hostname:'quota-test',os:'test',daemon_version:'test'})
    const agent=app.store.insertAgent({machine_id:machine.id,cli_kind:'codex_cli',cli_version:'test',config_path:''})
    const [daemon,digest]=generateDaemonToken()
    app.store.insertToken({user_id:owner.id,machine_id:machine.id,name:'quota-test',token_hash:digest})
    execFileSync('git',['init','-q',directory])
    const identity={agent_id:agent.id,native_id:'quota-native',session_key:'q'.repeat(64)}
    const headers={authorization:`Bearer ${daemon}`}
    const lifecycle={...identity,cwd:directory,event:'SessionStart',at:new Date().toISOString()}
    expect((await app.fastify.inject({method:'POST',url:'/api/memory/chat/native',headers,payload:lifecycle})).statusCode).toBe(200)
    const payload={...identity,action:'bind',provider:'openai',sample_started_at:new Date().toISOString()}
    const bind=(auth:string)=>app.fastify.inject({method:'POST',url:'/api/memory/usage/native',headers:{authorization:`Bearer ${auth}`},payload})
    expect((await bind(token)).statusCode).toBe(401)
    expect((await bind(daemon)).statusCode).toBe(200)
    const installed=(auth:string,id=agent.id)=>app.fastify.inject({method:'POST',url:'/api/memory/usage/installed',headers:{authorization:`Bearer ${auth}`},payload:{agent_id:id,action:'bind',provider:'openai',profile_ref:'c'.repeat(64),sample_started_at:new Date().toISOString()}})
    expect((await installed(token)).statusCode).toBe(401)
    expect((await installed(daemon)).statusCode).toBe(200)
    expect((await installed(daemon,'foreign')).statusCode).toBe(403)
    const server=computeSnapshot(app.store,agent.id).servers.find(s=>s.tools.some(t=>t.name==='usage_status'))!
    const tool=app.store.toolsOfServer(server.id).find(t=>t.name==='usage_status')!
    const disabled=await app.fastify.inject({method:'PUT',url:'/api/policy/rules',headers:{authorization:`Bearer ${token}`},payload:{scope:'user',resource_type:'mcp_tool',resource_id:tool.id,state:'off'}})
    expect(disabled.statusCode).toBe(204)
    expect((await bind(daemon)).statusCode).toBe(403)
    expect((await installed(daemon)).statusCode).toBe(403)
    expect((await app.fastify.inject({method:'POST',url:'/api/memory/chat/native',headers,payload:{...lifecycle,event:'Heartbeat'}})).statusCode).toBe(200)
  })
  it('el puente nativo exige daemon de la máquina y respeta el apagado del chat', async () => {
    const machine=app.store.insertMachine({user_id:owner.id,hostname:'native-one',os:'test',daemon_version:'test'})
    const other=app.store.insertMachine({user_id:owner.id,hostname:'native-two',os:'test',daemon_version:'test'})
    const agent=app.store.insertAgent({machine_id:machine.id,cli_kind:'codex_cli',cli_version:'test',config_path:''})
    const foreign=app.store.insertAgent({machine_id:other.id,cli_kind:'codex_cli',cli_version:'test',config_path:''})
    const [daemon,digest]=generateDaemonToken()
    app.store.insertToken({user_id:owner.id,machine_id:machine.id,name:'native-test',token_hash:digest})
    execFileSync('git',['init','-q',directory])
    const payload={agent_id:agent.id,native_id:'native-session',session_key:'a'.repeat(64),cwd:directory,event:'SessionStart',at:new Date().toISOString()}
    const invoke=(auth:string,body=payload)=>app.fastify.inject({method:'POST',url:'/api/memory/chat/native',headers:{authorization:`Bearer ${auth}`},payload:body})
    expect((await invoke(token)).statusCode).toBe(401)
    expect((await invoke(daemon,{...payload,transport:'opencode_prompt'})).statusCode).toBe(400)
    expect((await invoke(daemon,{...payload,agent_id:foreign.id})).statusCode).toBe(403)
    const registered=await invoke(daemon);expect(registered.statusCode).toBe(200)
    expect((await invoke(daemon)).json().session.id).toBe(registered.json().session.id)
    expect(registered.json()).toMatchObject({registration_required:true,session:{needs_nickname:true}})
    expect(registered.json()).not.toHaveProperty('channel');expect(registered.json()).not.toHaveProperty('team')
    const workspace='folder:12345678-1234-1234-1234-123456789abc'
    const scoped=await invoke(daemon,{...payload,native_id:'space-a',session_key:'b'.repeat(64),orca_workspace_id:workspace})
    expect(scoped.statusCode).toBe(200)
    const scoped2=await invoke(daemon,{...payload,native_id:'space-b',session_key:'c'.repeat(64),orca_workspace_id:'folder:22345678-1234-1234-1234-123456789abc'})
    expect(scoped2.statusCode).toBe(200)
    expect(scoped.json()).not.toHaveProperty('channel');expect(scoped2.json()).not.toHaveProperty('channel')
    const userCall=(operation:string,input:any)=>app.fastify.inject({method:'POST',url:'/api/memory/call',headers:{authorization:`Bearer ${token}`},payload:{operation,input}})
    // Transport connections remain invisible until each agent explicitly creates its channel.
    expect((await userCall('chat_channels',{})).json().items).toEqual([])
    const base=await app.fastify.listen({host:'127.0.0.1',port:0})
    const direct=new Client({name:'explicit-channels-test',version:'1'})
    try {
      await direct.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/memory/mcp`),{
        requestInit:{headers:{authorization:readFileSync(join(directory,'memory/secrets/memory-mcp'),'utf8')}},
      }))
      for(const [response,key,nick] of [[registered,'a','Git'],[scoped,'b','Orca A'],[scoped2,'c','Orca B']] as const) {
        const _meta={'agenthub/agent':{agent_id:agent.id,cli_kind:'codex_cli',client:'test',session_id:response.json().session.id,cwd:directory}}
        expect((await direct.callTool({name:'chat_set_nick',arguments:{session_key:key.repeat(64),nickname:nick},_meta})).isError).not.toBe(true)
        expect((await direct.callTool({name:'chat_create_channel',arguments:{session_key:key.repeat(64),name:nick},_meta})).isError).not.toBe(true)
      }
    } finally {await direct.close()}
    const channels=(await userCall('chat_channels',{})).json().items
    const participants=(await userCall('chat_agents',{include_pending:true})).json().items
    const channelOf=(response:any)=>channels.find((c:any)=>c.id===participants.find((p:any)=>p.id===response.json().session.id).channel_id)
    const registeredChannel=channelOf(registered),scopedChannel=channelOf(scoped),scoped2Channel=channelOf(scoped2)
    expect(registeredChannel.orca_workspace_id).toBeNull()
    expect(scopedChannel.path).toBe(scoped2Channel.path)
    expect(scopedChannel.id).not.toBe(scoped2Channel.id)
    expect(scopedChannel.id).not.toBe(registeredChannel.id)
    const project=await userCall('create_entity',{kind:'project',title:'Prueba de expulsión',data:{folders:[directory]}})
    await userCall('chat_channels',{}) // Refresh folder-to-project association.
    const kick={project_id:project.json().id,channel_id:registeredChannel.id,participant_id:registered.json().session.id,reason:'Retiro manual de prueba'}
    const remove=(auth?:string,body=kick)=>app.fastify.inject({method:'POST',url:'/api/memory/chat/kick',headers:auth?{authorization:`Bearer ${auth}`}:{},payload:body})
    expect((await remove()).statusCode).toBe(401)
    expect((await remove(daemon)).statusCode).toBe(401)
    expect((await userCall('chat_kick',{channel_id:kick.channel_id,participant_id:kick.participant_id,reason:kick.reason})).statusCode).toBe(403)
    expect((await remove(token,{...kick,channel_id:scopedChannel.id})).statusCode).toBe(404)
    const removed=await remove(token);expect(removed.statusCode).toBe(200)
    expect(removed.json().session).toMatchObject({state:'removed',removed_by:`user:${owner.id}`})
    expect((await invoke(daemon)).statusCode).toBe(410)
    expect((await invoke(daemon,{...payload,event:'Heartbeat'})).statusCode).toBe(410)
    expect((await invoke(daemon,{...payload,session_key:'d'.repeat(64)})).statusCode).toBe(410)
    const server=computeSnapshot(app.store,agent.id).servers.find(s=>s.tools.some(t=>t.name==='chat_join'))!
    const tool=app.store.toolsOfServer(server.id).find(t=>t.name==='chat_join')!
    expect((await app.fastify.inject({method:'PUT',url:'/api/policy/rules',headers:{authorization:`Bearer ${token}`},payload:{scope:'user',resource_type:'mcp_tool',resource_id:tool.id,state:'off'}})).statusCode).toBe(204)
    expect((await invoke(daemon)).statusCode).toBe(403)
  })

})
