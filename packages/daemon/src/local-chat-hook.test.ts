import { afterEach,expect,it,vi } from 'vitest'
import type { DaemonState } from './state.js'
import { cliProcess,localChatHook } from './local-chat-hook.js'
import { inspectNativeProcess,orcaWorkspaceId } from '@agenthub/gateway'
vi.mock('@agenthub/gateway',()=>({inspectNativeProcess:vi.fn(),orcaWorkspaceId:vi.fn(),orcaTerminalHandle:vi.fn()}))
afterEach(()=>{vi.resetAllMocks();vi.unstubAllGlobals()})
it('reconoce Codex aunque sus argumentos incluyan comandos de hooks',async()=> {
  vi.mocked(inspectNativeProcess).mockResolvedValue({parent:1,started:'birth',command:'codex --no-alt-screen -c hooks.Stop=[{command="node memory-hook"}]'})
  expect(await cliProcess('codex_cli')).toEqual({process_id:process.ppid,process_started:'birth'})
})
it('no atribuye la vida de un daemon compartido a una terminal concreta',async()=> {
  vi.mocked(inspectNativeProcess).mockResolvedValue({parent:1,started:'birth',command:'/bin/codex app-server --managed-daemon'})
  expect(await cliProcess('codex_cli')).toBeUndefined()
})
it('reconoce el ejecutable nativo de Windows',async()=> {
  vi.mocked(inspectNativeProcess).mockResolvedValue({parent:1,started:'birth',command:'C:\\tools\\codex.exe --no-alt-screen'})
  expect(await cliProcess('codex_cli')).toMatchObject({process_id:process.ppid})
})

it('mantiene una conexión pasiva en carpeta común sin afirmar que ya existe un canal',async()=> {
  const state={loadCredentials:()=>({token:'test',controlPlaneUrl:'http://127.0.0.1:8765'}),loadSnapshot:()=>({servers:[{tools:[{name:'chat_join'}]}]})} as unknown as DaemonState
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({session:{label:'Sin nick',id:'native:one'},channel:{id:'pending',path:'/ordinary',kind:'virtual',activated_at:null},team:{leader_id:null},pending:[]})}))
  const result=await localChatHook(state,'agent','codex_cli',{session_id:'session',cwd:'/ordinary',hook_event_name:'SessionStart'})
  expect(JSON.stringify(result.output)).toContain('sin canal activo')
  expect(JSON.stringify(result.output)).toContain('memory_chat_create_channel')
  expect(JSON.stringify(result.output)).toContain('sólo si la persona pide explícitamente')
})

it('un rechazo definitivo informa el motivo sin bloquear la CLI ni mantener listeners',async()=> {
  const state={loadCredentials:()=>({token:'test',controlPlaneUrl:'http://127.0.0.1:8765'}),loadSnapshot:()=>({servers:[{tools:[{name:'chat_join'}]}]})} as unknown as DaemonState
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:409}))
  const raw={session_id:'session',cwd:'/ordinary',hook_event_name:'SessionStart'}
  const result=await localChatHook(state,'agent','codex_cli',raw)
  expect(JSON.stringify(result.output)).toContain('canal fue cerrado')
  expect(result.code).toBeUndefined()
  expect(await localChatHook(state,'agent','claude_code',raw,'Watch')).toEqual({})
  expect(fetch).toHaveBeenCalledTimes(2)
})


it('transmite la identidad del espacio en hooks de clientes compatibles',async()=> {
  const id='folder:12345678-1234-1234-1234-123456789abc'
  vi.mocked(orcaWorkspaceId).mockReturnValue(id)
  const state={loadCredentials:()=>({token:'test',controlPlaneUrl:'http://127.0.0.1:8765'}),loadSnapshot:()=>({servers:[{tools:[{name:'chat_join'}]}]})} as unknown as DaemonState
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({})}))
  for(const kind of ['claude_code','codex_cli','gemini_cli','kiro','antigravity']) {
    await localChatHook(state,'agent',kind,{session_id:'session',cwd:'/same',hook_event_name:'Heartbeat'})
  }
  for(const [,options] of vi.mocked(fetch).mock.calls) expect(JSON.parse(options!.body as string)).toMatchObject({orca_workspace_id:id,cwd:'/same'})
})

it('mantiene la identidad y el coordinador con guía compacta recuperable entre turnos',async()=>{
  const state={loadCredentials:()=>({token:'test',controlPlaneUrl:'http://127.0.0.1:8765'}),loadSnapshot:()=>({servers:[{tools:[{name:'chat_join'}]}]})} as unknown as DaemonState
  const context={session:{label:'Revisor',id:'child',needs_nickname:false},channel:{id:'child-channel',path:'/worktree'},team:{scope:'channel',leader_id:'child',guidance_version:'v1',linked_team:{master_leader_id:'master'}},pending:[]}
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>context}))
  const raw={session_id:'session',cwd:'/worktree',hook_event_name:'UserPromptSubmit'}
  const response=JSON.stringify((await localChatHook(state,'agent','codex_cli',raw)).output)
  expect(response).toContain('líder del canal: child')
  expect(response).toContain('Coordinador del equipo vinculado: master')
  expect(response).toContain('versión de guía: v1')
  expect(response).toContain('recuperala con memory_chat_join')
  expect(response).not.toContain('Al comenzar cada turno')
  expect(await localChatHook(state,'agent','codex_cli',{...raw,hook_event_name:'PreToolUse'})).toEqual({})
})
