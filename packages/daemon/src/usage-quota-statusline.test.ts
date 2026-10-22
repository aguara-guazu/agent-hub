import { afterEach, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonState } from './state.js'
import { reportClaudeStatusline } from './usage-quota-statusline.js'
const paths:string[]=[]
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();for(const path of paths.splice(0))rmSync(path,{recursive:true,force:true})})
it.each([false,true])('statusline conserva busy y usa sólo identidad existente compatible con gateway (TUI=%s)',async(tui)=>{
 const root=mkdtempSync(join(tmpdir(),'quota-statusline-runtime-'));paths.push(root)
 const state=new DaemonState(root),token='isolated-test-token',agent='test-agent',native=tui?'tui:existing':'native-existing'
 state.saveCredentials({controlPlaneUrl:'http://localhost:23456',machineId:'test',userEmail:'',token})
 state.saveSnapshot({agent_instance_id:agent,cli_kind:'claude_code',servers:[{tools:[{name:'chat_join'},{name:'usage_status'}]}]})
 vi.stubEnv('AGENTHUB_TUI_AGENT',tui?agent:'');vi.stubEnv('AGENTHUB_TUI_SESSION',tui?native:'')
 let busy=true
 const payloads:Record<string,any>[]=[]
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
   const url=String(input),payload=JSON.parse(String(init?.body));payloads.push(payload)
   if(url.endsWith('/chat/native'))busy=false
   expect(url).toBe('http://localhost:23456/api/memory/usage/native')
   expect(payload.native_id).toBe(native)
   expect(payload.session_key).toBe(createHmac('sha256',token).update(JSON.stringify([agent,native])).digest('hex'))
   return new Response(JSON.stringify(payload.action==='bind'?{binding:{binding_id:agent+':profile:'+payload.profile_ref,binding_version:1,cli:'claude_code',provider:'anthropic'}}:{accepted:true}),{status:200})
 })
 const reset=Math.floor(Date.now()/1000)+3600
 await reportClaudeStatusline(root,agent,{session_id:'native-existing',cwd:root,rate_limits:{five_hour:{used_percentage:10,resets_at:reset},seven_day:{used_percentage:20,resets_at:reset}}})
 expect(payloads.map(p=>p.action)).toEqual(['bind','observe']);expect(payloads[0]?.profile_ref).toMatch(/^[a-f0-9]{64}$/)
 expect(payloads.every(p=>!p.event && !p.transport)).toBe(true);expect(busy).toBe(true)
})
it('statusline no registra identidad ausente si el Hub rechaza bind',async()=>{
 const root=mkdtempSync(join(tmpdir(),'quota-statusline-missing-'));paths.push(root)
 const state=new DaemonState(root)
 state.saveCredentials({controlPlaneUrl:'http://localhost:23456',machineId:'test',userEmail:'',token:'test-token'})
 state.saveSnapshot({agent_instance_id:'agent',cli_kind:'claude_code',servers:[{tools:[{name:'chat_join'},{name:'usage_status'}]}]})
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}',{status:409}))
 await reportClaudeStatusline(root,'agent',{session_id:'missing',cwd:root})
 await reportClaudeStatusline(root,'agent',{session_id:'missing',cwd:root})
 expect(fetch).toHaveBeenCalledOnce()
 expect(String(fetch.mock.calls[0]?.[0])).toContain('/usage/native')
})

it('redraws no renuevan frescura; cambios de cuota o cursor API sí generan una muestra',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-20T12:00:00Z'))
 const root=mkdtempSync(join(tmpdir(),'quota-statusline-fresh-'));paths.push(root)
 const state=new DaemonState(root),agent='fresh-agent'
 state.saveCredentials({controlPlaneUrl:'http://localhost:23456',machineId:'test',userEmail:'',token:'token'})
 state.saveSnapshot({agent_instance_id:agent,cli_kind:'claude_code',servers:[{tools:[{name:'chat_join'},{name:'usage_status'}]}]})
 const observations:Record<string,any>[]=[]
 vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
   const body=JSON.parse(String(init?.body))
   if(body.action==='observe')observations.push(body.observation)
   return new Response(JSON.stringify(body.action==='bind'?{binding:{binding_id:'test',binding_version:1,cli:'claude_code',provider:'anthropic'}}:{}))
 })
 const input={session_id:'stable',cwd:root,transcript_path:'PRIVATE_TRANSCRIPT',cost:{total_api_duration_ms:100,total_duration_ms:100},vim:{mode:'INSERT'},rate_limits:{five_hour:{used_percentage:10,resets_at:Date.now()/1000+3600},seven_day:{used_percentage:20,resets_at:Date.now()/1000+3600}}}
 await reportClaudeStatusline(root,agent,input)
 vi.setSystemTime(new Date(Date.now()+360000))
 await reportClaudeStatusline(root,agent,{...input,vim:{mode:'NORMAL'},cost:{...input.cost,total_duration_ms:999999}})
 expect(observations).toHaveLength(1)
 vi.setSystemTime(new Date(Date.now()+121000))
 await reportClaudeStatusline(root,agent,{...input,cost:{...input.cost,total_api_duration_ms:200}})
 expect(observations).toHaveLength(2)
 vi.setSystemTime(new Date(Date.now()+121000))
 await reportClaudeStatusline(root,agent,{...input,cost:{...input.cost,total_api_duration_ms:200},rate_limits:{...input.rate_limits,five_hour:{...input.rate_limits.five_hour,used_percentage:15}}})
 expect(observations).toHaveLength(3);expect(new Set(observations.map(o=>o.observed_at)).size).toBe(3)
 const evidence=readFileSync(join(root,'usage-statusline',readdirSync(join(root,'usage-statusline'))[0]!), 'utf8')
 expect(evidence).not.toContain('PRIVATE_TRANSCRIPT');expect(evidence).not.toContain('stable');expect(evidence).not.toContain('INSERT')
})
it('OFF detiene statusline sin afectar colaboración ni llamar al endpoint',async()=>{
 const root=mkdtempSync(join(tmpdir(),'quota-statusline-off-'));paths.push(root)
 const state=new DaemonState(root)
 state.saveCredentials({controlPlaneUrl:'http://localhost:23456',machineId:'test',userEmail:'',token:'token'})
 state.saveSnapshot({agent_instance_id:'agent',cli_kind:'claude_code',servers:[{tools:[{name:'chat_join'}]}]})
 const fetch=vi.spyOn(globalThis,'fetch')
 expect(await reportClaudeStatusline(root,'agent',{session_id:'native',cwd:root})).toBe('')
 expect(fetch).not.toHaveBeenCalled()
})

it('deadline absoluto aborta HTTP de cuota y no empieza el siguiente bucket',async()=>{
 const {NativeChatClient}=await import('./local-chat-client.js')
 const {collectProtocolQuota}=await import('./usage-quota-collector.js')
 const root=mkdtempSync(join(tmpdir(),'quota-http-deadline-'));paths.push(root)
 const state=new DaemonState(root)
 state.saveCredentials({controlPlaneUrl:'http://localhost:23456',machineId:'test',userEmail:'',token:'token'})
 state.saveSnapshot({agent_instance_id:'agent',cli_kind:'codex_cli',servers:[{tools:[{name:'chat_join'},{name:'usage_status'}]}]})
 const client=new NativeChatClient(state,'agent','native',root,'codex_appserver')
 let ready:()=>void=()=>{},reports=0
 const started=new Promise<void>(resolve=>{ready=resolve})
 vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
   const body=JSON.parse(String(init?.body))
   if(body.action==='bind')return new Response(JSON.stringify({binding:{binding_id:'agent',binding_version:1,cli:'codex_cli',provider:'openai',account_ref:body.account_ref}}))
   reports++;ready()
   return new Promise<Response>((_resolve,reject)=>{
     init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true})
   })
 })
 const bucket=(limitId:string)=>({limitId,primary:{usedPercent:5,resetsAt:Date.now()/1000+3600},secondary:null})
 const protocol={initialize:async()=>({}),request:async(method:string)=>method==='account/read'?{workspaceRouting:{chatgptAccountId:'A'}}:{accountId:'A',rateLimitsByLimitId:{one:bucket('codex'),two:bucket('extra')}}}
 const controller=new AbortController()
 const pending=collectProtocolQuota(protocol as unknown as import('./chat-protocol.js').ChatProtocol,'codex_cli',client,'profile',controller.signal)
 await started;controller.abort(new Error('absolute deadline'))
 await expect(pending).rejects.toThrow('absolute deadline');expect(reports).toBe(1)
})
