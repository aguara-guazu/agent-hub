import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { FleetProcessManager, type FleetEvent, type FleetStart, type FleetProcessOptions } from './fleet-process.js'

const managers: FleetProcessManager[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map(m => m.close()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
const fixture = String.raw`
const {createInterface}=require('node:readline');
const {spawn}=require('node:child_process');
const mode=process.env.FIXTURE_MODE;
const kind=process.argv[2];
const args=JSON.parse(process.argv[3]);
let queue=Promise.resolve();
const out=p=>{
 const line=JSON.stringify(p)+'\n';
 if(mode!=='fragmented')return process.stdout.write(line);
 queue=queue.then(()=>new Promise(resolve=>{
  process.stdout.write(line.slice(0,5));
  setTimeout(()=>{process.stdout.write(line.slice(5));resolve();},2);
 }));
};
const rpc=(id,result)=>out({id,result});
const forking=args.includes('--fork-session');
if(forking&&args.includes('--session-id'))process.exit(19);
let n=0,session=forking?(mode==='forkSame'?args[args.indexOf('--resume')+1]:'11111111-2222-4333-8444-555555555555'):(args[args.indexOf('--session-id')+1]||args[args.indexOf('--resume')+1]);
let active,descendant;
if(mode==='descendant') { descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});require('node:fs').writeFileSync(__dirname+'/descendant.pid',String(descendant.pid)); }
createInterface({input:process.stdin}).on('line',line=>{
 const p=JSON.parse(line);
 if(mode==='invalid') { process.stdout.write('NOT_JSON\n');return; }
 if(mode==='silent') return;
 if(mode==='exit') {process.exit(7);return;}
 if(mode==='secretError') {out({id:p.id,error:{message:'SECRET TRANSCRIPT'}});return;}
 if(kind==='codex') {
  if(p.method==='initialize') {
   if(process.env.ORCA_WORKTREE_ID||process.env.AGENTHUB_CHAT_SESSION_KEY||process.env.AGENTHUB_TUI_AGENT_ID||process.env.ELECTRON_RUN_AS_NODE||process.env.CLAUDECODE||process.env.CODEX_THREAD_ID) process.exit(8);
   rpc(p.id,{});
  }
  if(p.method==='thread/fork') {
   if(p.params.threadId!=='thread-source'||p.params.excludeTurns!==true||'cwd' in p.params||'model' in p.params||'sandbox' in p.params)process.exit(18);
   rpc(p.id,{thread:{id:mode==='forkSame'?p.params.threadId:'thread-native',sessionId:'root-session'}});
  }
  if(p.method==='thread/start'||p.method==='thread/resume') {
   if(p.params.approvalPolicy!=='never'||p.params.sandbox!=='danger-full-access')process.exit(9);
   rpc(p.id,{thread:{id:p.params.threadId||'thread-native'}});
  }
  if(p.id===42&&p.result) {
   if(p.result.answers.choice.answers[0]!=='PRIVATE ANSWER')process.exit(12);
   out({method:'item/completed',params:{threadId:'thread-native',item:{type:'userInput'}}});
  }
  if(p.method==='turn/start') {
   if(p.params.approvalPolicy!=='never'||p.params.sandboxPolicy.type!=='dangerFullAccess')process.exit(9);
   active='turn-'+(++n);
   if(mode==='observer') {
    out({method:'item/agentMessage/delta',params:{threadId:'unrelated',itemId:'foreign',delta:'FOREIGN OUTPUT'}});
    out({method:'item/agentMessage/delta',params:{threadId:'thread-native',turnId:active,itemId:'message',delta:'Hello '}});
    out({method:'item/completed',params:{threadId:'thread-native',turnId:active,item:{id:'message',type:'agentMessage',text:'Hello human'}}});
    const completeItem=item=>out({method:'item/completed',params:{threadId:'thread-native',turnId:active,item}});
    const mcp={id:'mcp',type:'mcpToolCall',server:'synthetic-server',tool:'lookup',arguments:{query:'synthetic query'},result:{content:[{type:'text',text:'synthetic MCP result'},{type:'image',data:'PRIVATE BINARY'}],_meta:{auth:'PRIVATE META'},structuredContent:{config:'PRIVATE STRUCTURED'}},appContext:{auth:'PRIVATE CONTEXT'}};
    out({method:'item/started',params:{threadId:'thread-native',turnId:active,item:{...mcp,result:null}}});
    completeItem(mcp);completeItem(mcp);
    completeItem({id:'dynamic',type:'dynamicToolCall',namespace:'synthetic',tool:'calculate',arguments:{value:2},contentItems:[{type:'inputText',text:'synthetic dynamic result'},{type:'inputImage',imageUrl:'PRIVATE IMAGE'}]});
    completeItem({id:'files',type:'fileChange',changes:[{path:'synthetic.txt',kind:{type:'update'},diff:'+synthetic diff',extra:'PRIVATE FILE META'}]});
    completeItem({id:'search',type:'webSearch',query:'synthetic search',action:{type:'findInPage',url:'https://example.test',pattern:'synthetic pattern'},results:[{auth:'PRIVATE SEARCH META'}]});
    completeItem({id:'unknown',type:'futureTool',auth:'PRIVATE UNKNOWN'});
    out({method:'item/started',params:{threadId:'thread-native',turnId:active,item:{id:'command',type:'commandExecution',command:'echo synthetic'}}});
    out({method:'item/commandExecution/outputDelta',params:{threadId:'thread-native',turnId:active,itemId:'command',delta:'synthetic'}});
    out({method:'item/completed',params:{threadId:'thread-native',turnId:active,item:{id:'command',type:'commandExecution',command:'echo synthetic',aggregatedOutput:'synthetic output'}}});
   }
   out({method:'turn/started',params:{threadId:'unrelated',turn:{id:'not-ours'}}});
   out({method:'item/agentMessage/delta',params:{threadId:'thread-native',delta:'SECRET TRANSCRIPT'}});
   process.stderr.write('SECRET STDERR\n');
   out({method:'turn/started',params:{threadId:'thread-native',turn:{id:active}}});
   const complete=()=>out({method:'turn/completed',params:{threadId:'thread-native',turn:{id:active,status:mode==='failed'?'failed':'completed',error:{message:'SECRET ERROR'}}}});
   if(mode==='fast') complete();
   if(mode.startsWith('question')) {
    const ask={method:'item/tool/requestUserInput',id:42,params:{threadId:'thread-native',turnId:active,isBlocking:true,questions:[{id:'choice',header:'Approach',question:'Which approach?',isOther:true,isSecret:false,options:[{label:'Yes',description:'Proceed'},{label:'No',description:'Wait'}]}]}};
    out(ask);out(ask);
    if(mode==='questionCancel')setTimeout(()=>out({method:'serverRequest/resolved',params:{threadId:'thread-native',requestId:42}}),150);
    if(mode==='questionFinish')setTimeout(()=>out({method:'turn/completed',params:{threadId:'thread-native',turn:{id:active,status:'completed'}}}),150);
   }
   rpc(p.id,{turn:{id:active,status:'inProgress'}});
   if(!mode.startsWith('question')&&!['hold','fast','descendant','steerRejected','steerRace','steerWrongAck','steerTimeout','steerComplete'].includes(mode)) setTimeout(complete,20);
  }
  if(p.method==='turn/steer') {
   if(p.params.expectedTurnId!==active||!p.params.clientUserMessageId||p.params.input[0].type!=='text')process.exit(11);
   if(mode==='steerTimeout')return;
   if(mode==='steerRace'||mode==='steerComplete')out({method:'turn/completed',params:{threadId:'thread-native',turn:{id:active,status:'completed'}}});
   if(mode==='steerRejected'||mode==='steerRace')out({id:p.id,error:{message:'SECRET rejected steer'}});
   else rpc(p.id,{turnId:mode==='steerWrongAck'?'unrelated-turn':active});
  }
  if(p.method==='turn/interrupt') {
   rpc(p.id,{});
   setTimeout(()=>out({method:'turn/completed',params:{threadId:'thread-native',turn:{id:active,status:'interrupted'}}}),20);
  }
 } else if(kind==='kiro-cli') {
  const update=(u,sessionId='kiro-native')=>out({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:u}});
  if(p.method==='initialize') {
   if(process.env.ORCA_WORKTREE_ID||process.env.AGENTHUB_CHAT_SESSION_KEY||process.env.AGENTHUB_TUI_AGENT_ID||process.env.ELECTRON_RUN_AS_NODE||process.env.CLAUDECODE||process.env.CODEX_THREAD_ID) process.exit(8);
   if(p.params.clientCapabilities.terminal!==false||p.params.clientCapabilities.fs.writeTextFile!==false)process.exit(9);
   rpc(p.id,{protocolVersion:1,agentCapabilities:{loadSession:true}});
  }
  if(p.method==='session/new'||p.method==='session/load') {
   if(!args.includes('--trust-all-tools')||args[0]!=='acp'||p.params.mcpServers.length)process.exit(9);
   rpc(p.id,p.method==='session/new'?{sessionId:'kiro-native'}:{});
  }
  if(p.method==='session/prompt') {
   if(p.params.sessionId!=='kiro-native'||p.params.prompt[0].type!=='text')process.exit(11);
   active=p.id;
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'FOREIGN OUTPUT'}},'unrelated');
   out({jsonrpc:'2.0',method:'_kiro.dev/metadata',params:{sessionId:'kiro-native',auth:'PRIVATE META'}});
   process.stderr.write('SECRET STDERR\n');
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello '}});
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'human'}});
   update({sessionUpdate:'tool_call',toolCallId:'call-1',title:'shell',rawInput:{command:'echo synthetic'},_meta:{auth:'PRIVATE META'}});
   update({sessionUpdate:'tool_call_update',toolCallId:'call-1',status:'completed',content:[{type:'content',content:{type:'text',text:'synthetic output'}},{type:'content',content:{type:'image',data:'PRIVATE BINARY'}}]});
   if(mode==='permission'){out({jsonrpc:'2.0',id:77,method:'session/request_permission',params:{sessionId:'kiro-native',options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}});return;}
   if(mode==='extension')out({jsonrpc:'2.0',id:78,method:'_kiro.dev/optional',params:{}});
   if(mode==='clientRequest'){out({jsonrpc:'2.0',id:79,method:'fs/read_text_file',params:{sessionId:'kiro-native',path:'/etc/hosts'}});return;}
   if(mode==='hold')return;
   setTimeout(()=>rpc(active,{stopReason:mode==='failed'?'refusal':'end_turn'}),20);
  }
  if(p.id===77&&!p.method) {
   if(p.result?.outcome?.outcome!=='cancelled')process.exit(15);
   rpc(active,{stopReason:'end_turn'});
  }
  if(p.id===78&&!p.method&&p.error?.code!==-32601)process.exit(16);
  if(p.method==='session/cancel') {
   if(p.params.sessionId!=='kiro-native')process.exit(17);
   setTimeout(()=>rpc(active,{stopReason:'cancelled'}),20);
  }
 } else {
  if(p.type==='user') {
   if(!n++)out({type:'system',subtype:'init',session_id:session});
   out({type:'assistant',session_id:session,message:{content:[{text:'SECRET TRANSCRIPT'}]}});
   if(mode==='observer') {
    out({type:'stream_event',session_id:session,event:{type:'message_start',message:{id:'message'}}});
    out({type:'stream_event',session_id:session,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello '}}});
    out({type:'assistant',session_id:session,message:{id:'message',content:[{type:'text',text:'Hello human'},{type:'tool_use',name:'Bash',input:{command:'echo synthetic'}}]}});
    out({type:'user',uuid:'tool-result',session_id:session,message:{content:[{type:'tool_result',content:[{type:'text',text:'synthetic output'}]}]}});
   }
   if(mode.startsWith('question')) {
    if(!args.includes('--permission-prompt-tool=stdio'))process.exit(13);
    const ask={type:'control_request',request_id:'native-question-42',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{questions:[{question:'Which approach?',header:'Approach',multiSelect:false,options:[{label:'Yes',description:'Proceed'},{label:'No',description:'Wait'}]}]}}};
    out(ask);out(ask);
    if(mode==='questionCancel')setTimeout(()=>out({type:'control_cancel_request',request_id:'native-question-42'}),150);
    return;
   }
   if(mode==='hold')return;
   setTimeout(()=>out({type:'result',subtype:mode==='failed'?'error_during_execution':'success',is_error:mode==='failed',session_id:session,uuid:'result-'+n,result:'SECRET RESULT'}),20);
  }
  if(p.type==='control_response') {
   if(p.response.subtype!=='success'||p.response.response.behavior!=='allow'||p.response.response.updatedInput.answers['Which approach?']!=='PRIVATE ANSWER')process.exit(14);
  }
  if(p.type==='control_request') setTimeout(()=>out({type:'result',subtype:'success',session_id:session,uuid:'interrupted'}),20);
 }
});
`
async function setup(mode = 'normal', extra: FleetProcessOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-process-test-')); dirs.push(dir)
  const file = join(dir, 'fixture.cjs'); await writeFile(file, fixture)
  const events: FleetEvent[] = []
  const launches: { command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = []
  const manager = new FleetProcessManager(dir, {
    requestTimeoutMs: 1500, shutdownTimeoutMs: 50,
    launcher: (command, args, options) => {
      launches.push({ command, args, env: options.env })
      return spawn(process.execPath, [file, command, JSON.stringify(args)], { ...options, env: { ...options.env, FIXTURE_MODE: mode }, stdio: 'pipe' })
    },
    onEvent: e => { events.push(e) }, ...extra,
  })
  managers.push(manager)
  const input: FleetStart = { id: 'one', cli: 'codex_cli', cwd: dir, model: 'test-model', effort: 'high', prompt: 'PRIVATE PROMPT' }
  return { manager, input, events, launches, dir }
}
async function until(predicate: () => boolean) {
  await expect.poll(predicate, { timeout: 2000, interval: 10 }).toBe(true)
}
describe('FleetProcessManager', () => {
  it.each(['codex_cli', 'claude_code'] as const)('captures only structured owned %s activity for the human observer', async cli => {
    const { manager, input, events, launches } = await setup('observer')
    await manager.start({ ...input, cli, prompt: 'Task invitation=synthetic-invitation-credential-12345' })
    await until(() => manager.status('one')?.state === 'idle')
    if (cli === 'claude_code') expect(launches[0]!.args).toContain('--include-partial-messages')
    const activity = manager.activity('one')
    expect(activity.supported).toBe(true)
    expect(activity.items.filter(item => item.kind === 'assistant').map(item => item.text).join('')).toBe('Hello human')
    expect(activity.items.filter(item => item.kind === 'tool').map(item => item.text).join('')).toContain('synthetic output')
    expect(JSON.stringify(activity)).not.toMatch(/FOREIGN OUTPUT|SECRET STDERR|synthetic-invitation-credential|PRIVATE (BINARY|META|STRUCTURED|CONTEXT|IMAGE|FILE META|SEARCH META|UNKNOWN)/)
    if (cli === 'codex_cli') {
      const tools = activity.items.filter(item => item.kind === 'tool').map(item => item.text).join('\n')
      expect(tools).toContain('synthetic-server/lookup {"query":"synthetic query"}')
      expect(tools.match(/synthetic MCP result/g)).toHaveLength(1)
      expect(tools).toContain('synthetic/calculate {"value":2}')
      expect(tools).toContain('synthetic dynamic result')
      expect(tools).toContain('update synthetic.txt\n+synthetic diff')
      expect(tools).toContain('webSearch synthetic search\nhttps://example.test\nsynthetic pattern')
    }
    expect(JSON.stringify([events, manager.status('one'), manager.list()])).not.toMatch(/Hello human|synthetic output/)
    await manager.stop('one')
    expect(manager.activity('one').items).toEqual(activity.items)
    await manager.start({ ...input, cli })
    expect(manager.activity('one').generation).not.toBe(activity.generation)
    expect(manager.activity('external').supported).toBe(false)
  })
  it('owns a background Codex conversation and emits metadata through interleaved output', async () => {
    const { manager, input, events, launches } = await setup()
    expect((await manager.start(input)).state).toBe('busy')
    await until(() => manager.status('one')?.state === 'idle')
    expect(events.map(e => e.state)).toContain('busy')
    expect(manager.status('one')?.native_id).toBe('thread-native')
    expect(JSON.stringify([events, manager.list(), launches[0]?.args])).not.toMatch(/SECRET|PRIVATE/)
    expect((await manager.send('one', 'NEXT PRIVATE PROMPT')).state).toBe('busy')
    await until(() => manager.status('one')?.state === 'idle')
    expect((await manager.stop('one')).state).toBe('stopped')
    expect(manager.status('one')?.turn_id).toBeUndefined()
    await expect(manager.send('one', 'no')).rejects.toThrow('fleet_not_idle')
  })
  it('owns a background Kiro ACP session with structured activity only', async () => {
    const { manager, input, events, launches } = await setup()
    const kiro = { ...input, cli: 'kiro' as const, prompt: 'Task invitation=synthetic-invitation-credential-12345' }
    expect((await manager.start(kiro)).state).toBe('busy')
    await until(() => manager.status('one')?.state === 'idle')
    expect(launches[0]!.command).toBe('kiro-cli')
    expect(launches[0]!.args).toEqual(['acp', '--model', 'test-model', '--effort', 'high', '--trust-all-tools'])
    expect(manager.status('one')?.native_id).toBe('kiro-native')
    const activity = manager.activity('one')
    expect(activity.items.filter(item => item.kind === 'assistant').map(item => item.text).join('')).toBe('Hello human')
    const tools = activity.items.filter(item => item.kind === 'tool').map(item => item.text).join('\n')
    expect(tools).toContain('shell {"command":"echo synthetic"}')
    expect(tools).toContain('synthetic output')
    expect(JSON.stringify(activity)).not.toMatch(/FOREIGN OUTPUT|SECRET STDERR|synthetic-invitation-credential|PRIVATE (BINARY|META)/)
    expect(JSON.stringify([events, manager.list()])).not.toMatch(/Hello human|synthetic output|PRIVATE/)
    expect(manager.supportsMidTurn('one')).toBe(false)
    expect((await manager.send('one', 'NEXT PRIVATE PROMPT')).state).toBe('busy')
    await until(() => manager.status('one')?.state === 'idle')
    expect((await manager.stop('one')).state).toBe('stopped')
  })
  it('interrupts a Kiro turn with session/cancel and waits for the prompt reply', async () => {
    const { manager, input } = await setup('hold')
    await manager.start({ ...input, cli: 'kiro' })
    await expect(manager.send('one', 'parallel')).rejects.toThrow('fleet_not_idle')
    expect((await manager.interrupt('one')).state).toBe('busy')
    await until(() => manager.status('one')?.state === 'idle')
    expect(manager.status('one')?.turn_id).toBeUndefined()
  })
  it.each([
    ['permission', 'idle', undefined],
    ['extension', 'idle', undefined],
    ['clientRequest', 'failed', 'fleet_unexpected_server_request'],
    ['failed', 'failed', 'fleet_turn_failed'],
  ] as const)('handles Kiro %s without granting anything', async (mode, state, error) => {
    const { manager, input } = await setup(mode)
    await manager.start({ ...input, cli: 'kiro' })
    await until(() => manager.status('one')?.state === state)
    expect(manager.status('one')?.error_code).toBe(error)
  })
  it('parses fragmented JSON packets without leaking their content', async () => {
    const { manager, input, events } = await setup('fragmented')
    await manager.start(input)
    await until(() => manager.status('one')?.state === 'idle')
    expect(JSON.stringify(events)).not.toContain('SECRET')
  })
  it('does not overwrite completion when notifications arrive before turn/start response', async () => {
    const { manager, input } = await setup('fast')
    expect((await manager.start(input)).state).toBe('idle')
    expect((await manager.send('one', 'again')).state).toBe('idle')
  })
  it('waits for an authoritative completion after interrupt and rejects concurrent input', async () => {
    const { manager, input } = await setup('hold')
    await manager.start(input)
    await expect(manager.send('one', 'parallel')).rejects.toThrow('fleet_not_idle')
    expect((await manager.interrupt('one')).state).toBe('busy')
    await until(() => manager.status('one')?.state === 'idle')
  })
  it('appends Codex input to the current turn without interrupting, starting a new turn or changing identity', async () => {
    const { manager, input, events } = await setup('hold')
    await manager.start(input)
    expect(manager.supportsMidTurn('one')).toBe(true)
    const before = manager.status('one')!
    const eventCount = events.length
    expect(await manager.enqueue('one', 'PRIVATE steer one')).toMatchObject({ state: 'busy', turn_id: before.turn_id, native_id: before.native_id })
    expect(await manager.enqueue('one', 'PRIVATE steer two')).toMatchObject({ state: 'busy', turn_id: before.turn_id })
    expect(events.slice(eventCount).map(e => e.state)).toEqual(['busy', 'busy'])
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|SECRET/)
  })
  it.each(['steerRejected', 'steerRace'])('keeps the process available after a rejected steer (%s)', async mode => {
    const { manager, input, events } = await setup(mode)
    await manager.start(input)
    await expect(manager.enqueue('one', 'PRIVATE')).rejects.toMatchObject({ message: 'fleet_steer_rejected', retryable: true })
    expect(manager.status('one')?.state).toBe(mode === 'steerRace' ? 'idle' : 'busy')
    expect(events.some(e => e.state === 'failed' || e.state === 'stopped')).toBe(false)
    if (mode === 'steerRace') expect((await manager.send('one', 'NEXT')).state).toBe('busy')
  })
  it.each(['steerWrongAck', 'steerTimeout'])('does not claim or replay delivery after an uncertain steer (%s)', async mode => {
    const { manager, input } = await setup(mode)
    await manager.start(input)
    await expect(manager.enqueue('one', 'PRIVATE')).rejects.toMatchObject({ message: 'fleet_steer_unconfirmed', retryable: false })
    expect(manager.status('one')).toMatchObject({ state: 'busy', turn_id: 'turn-1' })
  })
  it('does not turn a completed native turn busy again when the steer ACK arrives late', async () => {
    const { manager, input } = await setup('steerComplete')
    await manager.start(input)
    expect((await manager.enqueue('one', 'PRIVATE')).state).toBe('idle')
    expect(manager.status('one')?.turn_id).toBeUndefined()
  })
  it('reports Claude mid-turn enqueue unsupported instead of guessing native queue completion', async () => {
    const { manager, input } = await setup('hold')
    input.cli = 'claude_code'
    await manager.start(input)
    const before = manager.status('one')
    expect(manager.supportsMidTurn('one')).toBe(false)
    await expect(manager.enqueue('one', 'PRIVATE')).rejects.toThrow('fleet_mid_turn_unsupported')
    expect(manager.status('one')).toEqual(before)
  })
  it.each(['codex_cli', 'claude_code'] as const)('routes native %s questions with opaque IDs and responds without persisting answers', async cli => {
    const { manager, input, events } = await setup('question')
    input.cli = cli
    await manager.start(input)
    await until(() => manager.status('one')?.state === 'waiting_input')
    const before = manager.status('one')!
    expect(before.questions).toHaveLength(1)
    const pending = before.questions![0]!
    expect(pending.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(pending.id).not.toBe('42')
    expect(pending.questions[0]).toMatchObject({ header: 'Approach', question: 'Which approach?' })
    before.questions![0]!.questions[0]!.question = 'mutated'
    expect(manager.status('one')!.questions![0]!.questions[0]!.question).toBe('Which approach?')
    const questionId = pending.questions[0]!.id
    await expect(manager.answer('one', pending.id, { wrong: { answers: ['PRIVATE ANSWER'] } })).rejects.toThrow('fleet_invalid_answers')
    const after = await manager.answer('one', pending.id, { [questionId]: { answers: ['PRIVATE ANSWER'] } })
    expect(after).toMatchObject({ state: 'busy', turn_id: before.turn_id, questions: [] })
    await expect(manager.answer('one', pending.id, { [questionId]: { answers: ['PRIVATE ANSWER'] } })).rejects.toThrow('fleet_question_unavailable')
    expect(JSON.stringify(events)).not.toContain('PRIVATE ANSWER')
    expect(events.some(e => e.state === 'failed')).toBe(false)
  })
  it.each(['codex_cli', 'claude_code'] as const)('invalidates native %s question handles after cancellation and restart', async cli => {
    const { manager, input } = await setup('questionCancel')
    input.cli = cli
    await manager.start(input)
    await until(() => manager.status('one')?.state === 'waiting_input')
    const old = manager.status('one')!.questions![0]!
    await until(() => manager.status('one')?.questions?.length === 0)
    expect(manager.status('one')?.state).toBe('busy')
    await expect(manager.answer('one', old.id, { choice: { answers: ['PRIVATE ANSWER'] } })).rejects.toThrow('fleet_question_unavailable')
    await manager.stop('one')
    await manager.start(input)
    await until(() => manager.status('one')?.state === 'waiting_input')
    expect(manager.status('one')!.questions![0]!.id).not.toBe(old.id)
    await expect(manager.answer('one', old.id, { choice: { answers: ['PRIVATE ANSWER'] } })).rejects.toThrow('fleet_question_unavailable')
  })
  it.each(['codex_cli', 'claude_code'] as const)('interrupts native %s input waiting and invalidates questions only on native completion', async cli => {
    const { manager, input, events } = await setup('question')
    input.cli = cli
    await manager.start(input)
    await until(() => manager.status('one')?.state === 'waiting_input')
    const before = manager.status('one')!
    const pending = before.questions![0]!
    const interrupted = await manager.interrupt('one')
    expect(interrupted).toMatchObject({ state: 'waiting_input', turn_id: before.turn_id, questions: [pending] })
    expect(events.at(-1)?.state).toBe('waiting_input')
    await until(() => manager.status('one')?.state === 'idle')
    expect(manager.status('one')?.questions).toEqual([])
    expect(manager.status('one')?.turn_id).toBeUndefined()
    await expect(manager.answer('one', pending.id, { [pending.questions[0]!.id]: { answers: ['PRIVATE ANSWER'] } })).rejects.toThrow('fleet_question_unavailable')
    expect(events.some(e => e.state === 'failed' || e.state === 'stopped')).toBe(false)
  })
  it('does not accept an answer after its Codex turn completed', async () => {
    const { manager, input } = await setup('questionFinish')
    await manager.start(input)
    await until(() => manager.status('one')?.state === 'waiting_input')
    const old = manager.status('one')!.questions![0]!
    await until(() => manager.status('one')?.state === 'idle')
    expect(manager.status('one')?.questions).toEqual([])
    await expect(manager.answer('one', old.id, { choice: { answers: ['PRIVATE ANSWER'] } })).rejects.toThrow('fleet_question_unavailable')
  })
  it('runs Claude with permission bypass and waits for result, not assistant output', async () => {
    const { manager, input, events, launches } = await setup()
    input.cli = 'claude_code'
    expect((await manager.start(input)).state).toBe('busy')
    expect(launches[0]?.args).toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--input-format', 'stream-json', '--verbose', '--model', 'test-model', '--effort', 'high']))
    await until(() => manager.status('one')?.state === 'idle')
    expect(manager.status('one')?.native_id).toMatch(/^[0-9a-f-]{36}$/)
    expect((await manager.send('one', 'more')).state).toBe('busy')
    await until(() => manager.status('one')?.state === 'idle')
    expect(JSON.stringify(events)).not.toMatch(/SECRET|PRIVATE/)
  })
  it('fails on an authoritative Claude error result', async () => {
    const { manager, input, events } = await setup('failed')
    input.cli = 'claude_code'
    await manager.start(input)
    await until(() => manager.status('one')?.state === 'failed')
    expect(events.some(e => e.state === 'idle')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('SECRET')
  })
  it('uses the Claude protocol control request to interrupt', async () => {
    const { manager, input } = await setup('hold')
    input.cli = 'claude_code'
    await manager.start(input)
    expect((await manager.interrupt('one')).state).toBe('busy')
    await until(() => manager.status('one')?.state === 'idle')
  })
  it.each(['invalid', 'silent', 'exit', 'secretError', 'failed'])('fails safely for %s without output in metadata', async mode => {
    const { manager, input, events } = await setup(mode)
    await manager.start(input)
    await until(() => manager.status('one')?.state === 'failed')
    expect(JSON.stringify(events)).not.toContain('SECRET')
    if (mode !== 'failed') expect(events.some(e => e.state === 'idle' || e.state === 'busy')).toBe(false)
  })
  it('resumes explicitly, restarts stopped IDs, and protects a new generation from old callbacks', async () => {
    const { manager, input, events } = await setup('hold')
    input.resume_id = 'thread-native'
    await manager.start(input)
    await expect(manager.start(input)).rejects.toThrow('fleet_already_running')
    await manager.stop('one')
    await manager.start(input)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(manager.status('one')?.state).toBe('busy')
    expect(events.at(-1)?.state).toBe('busy')
  })
  it('forks a Claude conversation into a new native ID without choosing it', async () => {
    const { manager, input, launches } = await setup('hold')
    input.cli = 'claude_code'; input.resume_id = '3f9d2b6a-1c64-4b0e-8a77-0d5f2f6c9e11'; input.fork = true
    expect((await manager.start(input)).state).toBe('busy')
    const args = launches[0]!.args
    expect(args).toEqual(expect.arrayContaining(['--resume', input.resume_id, '--fork-session']))
    expect(args).not.toContain('--session-id')
    expect(manager.status('one')?.native_id).toBe('11111111-2222-4333-8444-555555555555')
  })
  it('rejects a Claude fork that answers with the source session', async () => {
    const { manager, input } = await setup('forkSame')
    input.cli = 'claude_code'; input.resume_id = '3f9d2b6a-1c64-4b0e-8a77-0d5f2f6c9e11'; input.fork = true
    await manager.start(input)
    await until(() => manager.status('one')?.state === 'failed')
    expect(manager.status('one')?.error_code).toBe('fleet_session_mismatch')
  })
  it('forks a Codex thread with only the documented parameters and adopts the new thread ID', async () => {
    const { manager, input } = await setup('hold')
    input.resume_id = 'thread-source'; input.fork = true
    expect((await manager.start(input)).state).toBe('busy')
    expect(manager.status('one')?.native_id).toBe('thread-native')
  })
  it('rejects a Codex fork that answers with the source thread', async () => {
    const { manager, input } = await setup('forkSame')
    input.resume_id = 'thread-source'; input.fork = true
    await manager.start(input)
    await until(() => manager.status('one')?.state === 'failed')
    expect(manager.status('one')?.error_code).toBe('fleet_session_mismatch')
  })
  it('refuses a fork without a source session or for a CLI that cannot fork', async () => {
    const { manager, input, launches } = await setup('hold')
    await expect(manager.start({ ...input, fork: true })).rejects.toThrow('fleet_fork_unsupported')
    await expect(manager.start({ ...input, cli: 'kiro', resume_id: 'kiro-native', fork: true })).rejects.toThrow('fleet_fork_unsupported')
    expect(launches).toHaveLength(0)
  })
  it('sanitizes parent identities and returns defensive metadata copies', async () => {
    const { manager, input, launches } = await setup('hold')
    const previous = process.env.ORCA_WORKTREE_ID
    const previousKey = process.env.AGENTHUB_CHAT_SESSION_KEY
    process.env.AGENTHUB_CHAT_SESSION_KEY = 'PRIVATE PARENT SESSION'
    process.env.ORCA_WORKTREE_ID = 'parent'
    try { await manager.start(input) } finally {
      if (previous === undefined) delete process.env.ORCA_WORKTREE_ID; else process.env.ORCA_WORKTREE_ID = previous
      if (previousKey === undefined) delete process.env.AGENTHUB_CHAT_SESSION_KEY; else process.env.AGENTHUB_CHAT_SESSION_KEY = previousKey
    }
    expect(launches[0]?.env?.ORCA_WORKTREE_ID).toBeUndefined()
    expect(launches[0]?.env?.AGENTHUB_CHAT_SESSION_KEY).toBeUndefined()
    const status = manager.status('one')!; status.state = 'idle'
    expect(manager.status('one')?.state).toBe('busy')
    await manager.close()
    expect(manager.status('one')?.state).toBe('stopped')
    await expect(manager.start(input)).rejects.toThrow('fleet_manager_closed')
  })
  it.skipIf(process.platform === 'win32')('kills only the owned process group, including descendants', async () => {
    const { manager, input, dir } = await setup('descendant')
    await manager.start(input)
    const pid = Number(await readFile(join(dir, 'descendant.pid'), 'utf8'))
    expect(pid).toBeGreaterThan(0)
    process.kill(pid, 0)
    await manager.stop('one')
    await until(() => { try { process.kill(pid, 0); return false } catch { return true } })
  })
  it('serializes asynchronous metadata delivery and fails if persistence rejects', async () => {
    const delivered: string[] = []
    const { manager, input } = await setup('hold', {
      onEvent: async event => {
        await new Promise(resolve => setTimeout(resolve, event.state === 'starting' ? 30 : 0))
        delivered.push(event.state)
        if (event.state === 'busy') throw new Error('PRIVATE database failure')
      },
    })
    expect((await manager.start(input)).state).toBe('failed')
    await until(() => delivered.includes('failed'))
    expect(delivered.slice(0, 2)).toEqual(['starting', 'busy'])
    expect(manager.status('one')?.error_code).toBe('fleet_event_delivery_failed')
  })
  it('prevents simultaneous starts and a start racing manager close', async () => {
    const { manager, input } = await setup('silent')
    const starting = manager.start(input)
    await expect(manager.start(input)).rejects.toThrow('fleet_already_running')
    await manager.close()
    expect((await starting).state).toBe('stopped')
    expect(manager.status('one')?.state).toBe('stopped')
  })
  it('refuses to replace a failed process whose exit could not be confirmed', async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcessWithoutNullStreams
    let launches = 0
    const { manager, input } = await setup('normal', { launcher: () => { launches++; return child }, requestTimeoutMs: 5, shutdownTimeoutMs: 5 })
    expect((await manager.start(input)).state).toBe('failed')
    await expect(manager.start(input)).rejects.toThrow('fleet_previous_process_unconfirmed')
    expect(launches).toBe(1)
    expect((await manager.stop('one')).state).toBe('unknown')
  })
  it('reports spawn failures without claiming work started', async () => {
    const { manager, input, events } = await setup('normal', {
      launcher: (_command, _args, options) => spawn('/no/such/fleet-test-executable', [], { ...options, stdio: 'pipe' }),
    })
    expect((await manager.start(input)).state).toBe('failed')
    expect(events.map(e => e.state)).toEqual(['starting', 'failed'])
  })
})
