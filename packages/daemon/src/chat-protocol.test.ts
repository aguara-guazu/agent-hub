import { afterEach, expect, it, vi } from 'vitest'
import { ChatProtocol } from './chat-protocol.js'
import { ConnectedChatSession, chatInvocation } from './chat-terminal.js'
import type { NativeChatClient } from './local-chat-client.js'

const processes:ChatProtocol[]=[]
afterEach(async()=>{await Promise.all(processes.splice(0).map(p=>p.close()))})
const fixture=`
const {createInterface}=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let turns=0,waiting;
createInterface({input:process.stdin}).on('line',line=>{
 const p=JSON.parse(line);
 if(p.method==='initialize')return send({id:p.id,result:{agentCapabilities:{loadSession:true}}});
 if(p.method==='session/new')return send({id:p.id,result:{sessionId:'native-session'}});
 if(p.method==='session/load')return send({id:p.id,result:{}});
 if(p.method==='session/prompt'){
   const text=p.params.prompt[0].text;
   if(text.includes('crash'))return process.exit(2);
   if(text.includes('permission')){waiting=p;return send({jsonrpc:'2.0',id:900,method:'session/request_permission',params:{sessionId:p.params.sessionId,options:[{optionId:'once',kind:'allow_once',name:'Once'}]}})}
   send({method:'session/update',params:{sessionId:p.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'turn '+(++turns)}}}});
   return setTimeout(()=>send({id:p.id,result:{stopReason:'end_turn',sessionId:p.params.sessionId,turns}}),10);
 }
 if(p.id===900)return send({id:waiting.id,result:{stopReason:'end_turn',permission:p.result}});
});`
const start=async(code=fixture,format:'acp'|'antigravity'|'codex'='acp',permission=vi.fn(async()=>({outcome:{outcome:'cancelled'}})))=>{
 const output=vi.fn(),p=new ChatProtocol(format,process.execPath,['-e',code],process.cwd(),output,permission)
 processes.push(p);await p.start(process.cwd(),[]);return {p,output,permission}
}
it('usa un proceso y la misma sesión ACP para varios turnos, incluso después de quedar en reposo',async()=>{
 const {p,output}=await start(),pid=p.child.pid
 expect(await p.prompt('uno')).toMatchObject({turns:1,sessionId:'native-session'})
 expect(await p.prompt('dos')).toMatchObject({turns:2,sessionId:'native-session'})
 expect(p.child.pid).toBe(pid);expect(output.mock.calls.flat()).toContain('turn 2')
})
it('delega permisos al usuario y no los aprueba cuando una solicitud no corresponde a su sesión',async()=>{
 const {p,permission}=await start()
 expect(await p.prompt('permission')).toMatchObject({permission:{outcome:{outcome:'cancelled'}}})
 expect(permission).toHaveBeenCalledOnce()
 const other=await start(fixture.replace('sessionId:p.params.sessionId,options','sessionId:"foreign",options'))
 expect(await other.p.prompt('permission')).toMatchObject({permission:{outcome:{outcome:'cancelled'}}})
 expect(other.permission).not.toHaveBeenCalled()
})
it('rechaza turnos pendientes cuando muere la CLI sin repetirlos en otra conversación',async()=>{
 const {p}=await start()
 await expect(p.prompt('crash')).rejects.toThrow('terminó')
 await expect(p.prompt('otro')).rejects.toThrow('cerrada')
})
it('respeta el ID solicitado al retomar una conversación ACP',async()=>{
 const output=vi.fn(),p=new ChatProtocol('acp',process.execPath,['-e',fixture],process.cwd(),output,async()=>({}))
 processes.push(p);await p.start(process.cwd(),[],'saved-session')
 expect(await p.prompt('continuar')).toMatchObject({sessionId:'saved-session'})
})
it('mantiene Antigravity abierto entre resultados y rechaza fallos de permiso',async()=>{
 const code=`const {createInterface}=require('node:readline');const send=x=>console.log(JSON.stringify(x));
 send({event:'init',conversation_id:'agy-session'});let turns=0;
 createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);send({event:'step_update',step_update:{text_delta:x.message.content}});send({event:'result',result:{conversation_id:'agy-session',status:++turns===3?'WAITING':'SUCCESS',num_turns:turns}})});`
 const {p}=await start(code,'antigravity'),pid=p.child.pid
 expect(await p.prompt('uno')).toMatchObject({num_turns:1})
 expect(await p.prompt('dos')).toMatchObject({num_turns:2})
 await expect(p.prompt('tres')).rejects.toThrow('WAITING');expect(p.child.pid).toBe(pid)
})
it('serializa pedidos humanos y del Hub y deja bloqueada la sesión si falla un turno',async()=>{
 const {p}=await start(),send=vi.fn(async()=>({})),broker={send,context:()=> 'context'} as unknown as NativeChatClient
 const session=new ConnectedChatSession(p,broker)
 await Promise.all([session.submit('primero'),session.submit('segundo')])
 expect(send.mock.calls.flat()).toEqual(['UserPromptSubmit','Stop','UserPromptSubmit','Stop'])
 await expect(session.submit('crash')).rejects.toThrow('terminó')
 expect(send).toHaveBeenLastCalledWith('StopFailure')
 await session.close();expect(send).toHaveBeenLastCalledWith('SessionEnd')
})
it.each(['codex_cli','gemini_cli','kiro','antigravity'])('no agrega bypass de permisos ni cambia el modelo en %s',kind=>{
 const invocation=chatInvocation(kind,[])
 expect(invocation.args.join(' ')).not.toMatch(/trust|yolo|skip|model|effort/)
})

it('Codex crea la conversación sin inferencia y recibe turnos y aprobaciones en su app-server',async()=>{
 const code=`const {createInterface}=require('node:readline'); const send=x=>console.log(JSON.stringify(x));let turns=0,waiting;
 createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);
 if(p.method==='initialize')return send({id:p.id,result:{userAgent:'fixture'}});
 if(p.method==='thread/start')return send({id:p.id,result:{thread:{id:'codex-native'}}});
 if(p.method==='turn/start'){
 const turn={id:'turn-'+(++turns),status:'inProgress'};
 send({id:p.id,result:{turn}});send({method:'turn/started',params:{threadId:'codex-native',turn}});
 send({method:'item/agentMessage/delta',params:{threadId:'foreign',delta:'FOREIGN'}});
 send({method:'item/agentMessage/delta',params:{threadId:'codex-native',delta:'turn '+turns}});
 if(p.params.input[0].text.includes('permission')){waiting=turn;return send({id:900,method:'item/commandExecution/requestApproval',params:{threadId:'codex-native',command:'test',turnId:turn.id}})}
 return send({method:'turn/completed',params:{threadId:'codex-native',turn:{...turn,status:'completed'}}});
 }
 if(p.id===900){send({method:'item/agentMessage/delta',params:{threadId:'codex-native',delta:p.result.decision}});send({method:'turn/completed',params:{threadId:'codex-native',turn:{...waiting,status:'completed'}}})}
 });`
 const {p,output,permission}=await start(code,'codex')
 expect(p.sessionId).toBe('codex-native');expect(output).not.toHaveBeenCalled()
 await p.prompt('one');await p.prompt('permission')
 expect(output.mock.calls.flat()).toEqual(['turn 1','turn 2','cancel'])
 expect(permission).toHaveBeenCalledOnce()
})
it('un aviso del Hub mantiene ocupado al receptor sin atribuirlo a un pedido humano',async()=>{
 const {p}=await start(),send=vi.fn(async()=>({})),broker={send,context:()=> 'context'} as unknown as NativeChatClient
 const session=new ConnectedChatSession(p,broker)
 await session.submit('mensaje del equipo',true)
 expect(send.mock.calls.flat()).toEqual(['HubPromptSubmit','Stop']);await session.close()
})
