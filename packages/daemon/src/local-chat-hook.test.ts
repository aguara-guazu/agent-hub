import { afterEach,expect,it,vi } from 'vitest'
import type { DaemonState } from './state.js'
import { cliProcess,localChatHook } from './local-chat-hook.js'
import { inspectNativeProcess,orcaWorkspaceId } from '@agenthub/gateway'
vi.mock('@agenthub/gateway',()=>({inspectNativeProcess:vi.fn(),orcaWorkspaceId:vi.fn(),orcaTerminalHandle:vi.fn()}))
afterEach(()=>{vi.resetAllMocks();vi.unstubAllGlobals();vi.useRealTimers()})
it('no inspecciona procesos de clientes sin identificación compatible',async()=>{
  expect(await cliProcess('gemini_cli')).toBeUndefined()
  expect(inspectNativeProcess).not.toHaveBeenCalled()
})
it('limita toda la búsqueda de ancestros y envía el evento aunque la inspección se demore',async()=>{
  vi.useFakeTimers()
  const budget=process.platform==='win32'?1500:400
  vi.mocked(inspectNativeProcess).mockImplementationOnce(async()=>{
    await new Promise(resolve=>setTimeout(resolve,budget/2))
    return {parent:42,started:'birth',command:'/bin/sh'}
  }).mockImplementationOnce(async(_pid,signal)=>new Promise(resolve=>{
    signal!.addEventListener('abort',()=>resolve(undefined),{once:true})
  }))
  const state={loadCredentials:()=>({token:'test',controlPlaneUrl:'http://127.0.0.1:8765'}),loadSnapshot:()=>({servers:[{tools:[{name:'chat_join'}]}]})} as unknown as DaemonState
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({session:{label:'Agent',id:'native:one'},channel:{id:'channel',path:'/worktree'},pending:[]})}))
  const result=localChatHook(state,'agent','claude_code',{session_id:'session',cwd:'/worktree',hook_event_name:'UserPromptSubmit'})
  await vi.advanceTimersByTimeAsync(budget-1)
  expect(fetch).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(JSON.stringify((await result).output)).toContain('Agent Hub')
  expect(inspectNativeProcess).toHaveBeenCalledTimes(2)
  expect(vi.mocked(inspectNativeProcess).mock.calls[1]![1]!.aborted).toBe(true)
  const sent=JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)
  expect(sent.event).toBe('UserPromptSubmit')
  expect(sent).not.toHaveProperty('process_id')
  expect(sent).not.toHaveProperty('process_started')
})
it('reconoce Codex aunque sus argumentos incluyan comandos de hooks',async()=> {
  vi.mocked(inspectNativeProcess).mockResolvedValue({parent:1,started:'birth',command:'codex --no-alt-screen -c hooks.Stop=[{command="node memory-hook"}]'})
  expect(await cliProcess('codex_cli')).toEqual({process_id:process.ppid,process_started:'birth'})
})
it('no atribuye la vida de un daemon compartido a una terminal concreta',async()=> {
  vi.mocked(inspectNativeProcess).mockResolvedValue({parent:1,started:'birth',command:'/bin/codex app-server --managed-daemon'})
  expect(await cliProcess('codex_cli')).toBeUndefined()
})
it('conserva la fecha observada aunque la inspección del proceso demore el POST',async()=>{
  const observedAt='2026-10-22T10:00:00.000Z'
  const state={loadCredentials:()=>({token:'test',controlPlaneUrl:'http://127.0.0.1:8765'}),loadSnapshot:()=>({servers:[{tools:[{name:'chat_join'}]}]})} as unknown as DaemonState
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({})}))
  await localChatHook(state,'agent','claude_code',{session_id:'session',cwd:'/worktree',hook_event_name:'Stop'},undefined,observedAt)
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string).at).toBe(observedAt)
})
it('reconoce el ejecutable nativo de Windows',async()=> {
  vi.mocked(inspectNativeProcess).mockResolvedValue({parent:1,started:'birth',command:'C:\\tools\\codex.exe --no-alt-screen'})
  expect(await cliProcess('codex_cli')).toMatchObject({process_id:process.ppid})
})

it('mantiene una conexión pasiva en carpeta común sin afirmar que ya existe un canal',async()=> {
  const state={loadCredentials:()=>({token:'test',controlPlaneUrl:'http://127.0.0.1:8765'}),loadSnapshot:()=>({servers:[{tools:[{name:'chat_join'}]}]})} as unknown as DaemonState
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({session:{label:'Sin nick',id:'native:one'},channel:{id:'pending',path:'/ordinary',kind:'virtual',activated_at:null},team:{leader_id:null},pending:[]})}))
  const result=await localChatHook(state,'agent','codex_cli',{session_id:'session',cwd:'/ordinary',hook_event_name:'SessionStart'})
  expect(JSON.stringify(result.output)).toContain('no active channel')
  expect(JSON.stringify(result.output)).toContain('Hub multi-agent group, or solo with the normal agent')
  expect(JSON.stringify(result.output)).toContain('Solo: no nickname')
  expect(JSON.stringify(result.output)).toContain('memory_chat_create_channel')
  expect(JSON.stringify(result.output)).toContain('Before creating a channel, ask')
})

it('un rechazo definitivo informa el motivo sin bloquear la CLI ni mantener listeners',async()=> {
  const state={loadCredentials:()=>({token:'test',controlPlaneUrl:'http://127.0.0.1:8765'}),loadSnapshot:()=>({servers:[{tools:[{name:'chat_join'}]}]})} as unknown as DaemonState
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:409}))
  const raw={session_id:'session',cwd:'/ordinary',hook_event_name:'SessionStart'}
  const result=await localChatHook(state,'agent','codex_cli',raw)
  expect(JSON.stringify(result.output)).toContain('channel closed')
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
  expect(response).toContain('channel leader: child')
  expect(response).toContain('Linked team coordinator: master')
  expect(response).toContain('guidance version: v1')
  expect(response).toContain('recover it with memory_chat_join')
  expect(response).not.toContain('At the start of each turn')
  expect(await localChatHook(state,'agent','codex_cli',{...raw,hook_event_name:'PreToolUse'})).toEqual({})
})


it.each(['PreToolUse','BeforeTool','PostToolUse','PostToolUseFailure'])('avisa pendientes en %s sin repetir bootstrap ni copiar contenido de mensajes',async(event)=>{
  const state={loadCredentials:()=>({token:'test',controlPlaneUrl:'http://127.0.0.1:8765'}),loadSnapshot:()=>({servers:[{tools:[{name:'chat_join'}]}]})} as unknown as DaemonState
  const pending=Array.from({length:12},(_,index)=>({message_id:`message-${index}`,thread_id:'thread',text:'INJECTED MESSAGE BODY'}))
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({session:{label:'Agent',id:'native:one'},channel:{id:'channel',path:'/worktree'},team:{guidance:'FULL BOOTSTRAP'},pending})}))
  const result=await localChatHook(state,'agent','claude_code',{session_id:'session',cwd:'/worktree',hook_event_name:event,tool_input:{prompt:'PRIVATE USER PROMPT'},tool_response:'PRIVATE TOOL OUTPUT'})
  const output=result.output as {hookSpecificOutput:{hookEventName:string;additionalContext:string}}
  expect(output.hookSpecificOutput.hookEventName).toBe(event)
  const context=output.hookSpecificOutput.additionalContext
  expect(context).toContain('12 pending notices')
  expect(context).toContain('message-0')
  expect(context).not.toContain('message-10')
  expect(context).toContain('partial list')
  expect(context).toContain('memory_chat_inbox')
  expect(context).toMatch(/session_key=[a-f0-9]{64}/)
  expect(context).toContain('author_id')
  expect(context).not.toMatch(/FULL BOOTSTRAP|INJECTED MESSAGE BODY|PRIVATE USER PROMPT|PRIVATE TOOL OUTPUT/)
  expect(fetch).toHaveBeenCalledTimes(1)
  const sent=JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)
  expect(sent).not.toHaveProperty('tool_input')
  expect(sent).not.toHaveProperty('tool_response')
  expect(result.code).toBeUndefined()
})

it.each(['PreToolUse','BeforeTool','PostToolUse','PostToolUseFailure'])('no inyecta contexto en %s sin pendientes',async(event)=>{
  const state={loadCredentials:()=>({token:'test',controlPlaneUrl:'http://127.0.0.1:8765'}),loadSnapshot:()=>({servers:[{tools:[{name:'chat_join'}]}]})} as unknown as DaemonState
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({pending:[]})}))
  expect(await localChatHook(state,'agent','claude_code',{session_id:'session',cwd:'/worktree',hook_event_name:event})).toEqual({})
})

it('injects only enrollment before naming even when a legacy response contains channel and peer names',async()=>{
  const state={loadCredentials:()=>({token:'test',controlPlaneUrl:'http://127.0.0.1:8765'}),loadSnapshot:()=>({servers:[{tools:[{name:'chat_join'}]}]})} as unknown as DaemonState
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({session:{id:'native:one',needs_nickname:true},channel:{id:'secret-channel',name:'SECRET CHANNEL',path:'/secret/path'},team:{leader_nickname:'SECRET PEER'},pending:[{message_id:'secret-message'}]})}))
  const result=await localChatHook(state,'agent','gemini_cli',{session_id:'session',cwd:'/worktree',hook_event_name:'SessionStart'})
  const context=JSON.stringify(result.output)
  expect(context).toContain('memory_chat_set_nick')
  expect(context).not.toContain('SECRET');expect(context).not.toContain('/secret');expect(context).not.toContain('secret-message')
  const boundary=await localChatHook(state,'agent','gemini_cli',{session_id:'session',cwd:'/worktree',hook_event_name:'PreToolUse'})
  expect(boundary).toEqual({})
})

it('reenvía model y source del payload nativo sólo cuando tienen la forma esperada y nunca en Watch',async()=>{
  const state={loadCredentials:()=>({token:'test',controlPlaneUrl:'http://127.0.0.1:8765'}),loadSnapshot:()=>({servers:[{tools:[{name:'chat_join'}]}]})} as unknown as DaemonState
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({})}))
  const sent=()=>JSON.parse(vi.mocked(fetch).mock.calls.at(-1)![1]!.body as string)
  await localChatHook(state,'agent','claude_code',{session_id:'session',cwd:'/worktree',hook_event_name:'SessionStart',model:'claude-sonnet-5-5',source:'resume'})
  expect(sent()).toMatchObject({event:'SessionStart',model:'claude-sonnet-5-5',source:'resume'})
  await localChatHook(state,'agent','codex_cli',{session_id:'session',cwd:'/worktree',hook_event_name:'Stop',model:'gpt-x',source:'Not A Source!'})
  expect(sent()).toMatchObject({model:'gpt-x'})
  expect(sent()).not.toHaveProperty('source')
  await localChatHook(state,'agent','codex_cli',{session_id:'session',cwd:'/worktree',hook_event_name:'Stop',model:'x'.repeat(201),source:42})
  expect(sent()).not.toHaveProperty('model')
  expect(sent()).not.toHaveProperty('source')
  await localChatHook(state,'agent','codex_cli',{session_id:'session',cwd:'/worktree',hook_event_name:'Stop'})
  expect(sent()).not.toHaveProperty('model')
})

it('reporta to_model de PostModelSwitch como el modelo observado y no confunde el campo model de otros eventos',async()=>{
  const state={loadCredentials:()=>({token:'test',controlPlaneUrl:'http://127.0.0.1:8765'}),loadSnapshot:()=>({servers:[{tools:[{name:'chat_join'}]}]})} as unknown as DaemonState
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({})}))
  const sent=()=>JSON.parse(vi.mocked(fetch).mock.calls.at(-1)![1]!.body as string)
  await localChatHook(state,'agent','claude_code',{session_id:'session',cwd:'/worktree',hook_event_name:'PostModelSwitch',from_model:'claude-a',to_model:'claude-b'})
  expect(sent()).toMatchObject({event:'PostModelSwitch',model:'claude-b'})
  await localChatHook(state,'agent','claude_code',{session_id:'session',cwd:'/worktree',hook_event_name:'PostModelSwitch',from_model:'claude-a',model:'ignored'})
  expect(sent()).not.toHaveProperty('model')
})
