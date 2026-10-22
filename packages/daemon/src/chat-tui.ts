import { startQuotaCollector } from './usage-quota-collector.js'
import { resumedTuiSession } from '@agenthub/gateway'
import { randomUUID } from 'node:crypto'
import { spawn as spawnChild } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import pty from '@lydell/node-pty'
import xterm from '@xterm/headless'
import { DaemonState } from './state.js'
import { NativeChatClient, ChatConnectionError } from './local-chat-client.js'
import { chatExecutable } from './chat-terminal.js'

/** Native arguments stay opaque. In particular, permissions are interpreted by the CLI. */
export function tuiInvocation(kind:string,args:string[]) {
  const commands:Record<string,string>={claude_code:'claude',codex_cli:'codex',kiro:'kiro-cli',gemini_cli:'gemini',opencode:'opencode',antigravity:'agy'}
  const command=commands[kind]
  if(!command)throw new Error('Este cliente no tiene una terminal interactiva.')
  return {command,args:kind==='kiro'?['chat','--tui',...args]:args}
}

/** Only recognized, empty native composers accept a notification. Unknown screens defer. */
export function emptyTuiComposer(kind:string,lines:string[],cursorY:number):boolean {
  const footer=lines.slice(Math.max(0,cursorY-5),cursorY+7).join('\n')
  if(/(?:esc|ctrl.?c)\s+(?:to\s+)?(?:interrupt|cancel)|kiro is working|thinking|working[.…]|permission (?:requested|required)|allow once|trust this|\bconfirm\b|elegí|approve (?:this|once)|do you trust/i.test(footer))return false
  const patterns:Record<string,RegExp>={
    kiro:/^\s*›\s+ask a question or describe a task\s*↵?\s*$/i,
    codex_cli:/^\s*›\s*(?:Ask Codex to do anything|Find and fix a bug in @filename|Explain this codebase|Write tests for @filename|Summarize recent commits|Implement \{feature\}|Improve documentation in @filename)?\s*$/i,
    claude_code:/^\s*❯\s*$/,
    gemini_cli:/^[\s│┃]*>\s*(?:Type your message or @path\/to\/file|Type your message|Ask Gemini)?\s*[│┃]?\s*$/i,
    opencode:/^\s*(?:Ask anything(?:…|\.\.\.)?|>\s*)$/,
    antigravity:/^\s*[›>]\s*(?:Ask anything|Type your message)?\s*$/i,
  }
  const pattern=patterns[kind]
  if(!pattern)return false
  // Use the cursor's composer, never a prompt quoted in chat history.
  return lines.some((line,index)=>Math.abs(index-cursorY)<=1 && pattern.test(line))
}

/** Full native UI over an owned PTY: ANSI, mouse, keyboard, resize and approvals pass through. */
export async function runChatTui(stateDir:string,agentId:string,args:string[]=[]) {
  const state=new DaemonState(stateDir),snapshot=state.loadSnapshot(agentId)
  if(!snapshot)throw new Error('Sincronizá este cliente con Agent Hub antes de abrirlo.')
  const kind=String(snapshot['cli_kind']),invocation=tuiInvocation(kind,args)
  const searchPath=[process.env.PATH,join(homedir(),'.local/bin'),...(process.platform==='win32'?[process.env.APPDATA&&join(process.env.APPDATA,'npm')]:['/opt/homebrew/bin','/usr/local/bin'])].filter(Boolean).join(delimiter)
  const executable=chatExecutable(invocation.command,searchPath)
  const env={...process.env,PATH:searchPath}
  // Help/version and piped commands keep their native behavior and do not create ghost agents.
  if(!process.stdin.isTTY || !process.stdout.isTTY || args.some(a=>['--help','-h','--version','-V'].includes(a))) {
    const child=spawnChild(executable.command,[...executable.prefix,...invocation.args],{stdio:'inherit',env})
    return new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1))})
  }
  const bindings=join(state.root,'tui-sessions',agentId)
  const resumeAt=args.findIndex(a=>['--resume-id','--resume','resume','--session','--session-id',...(kind==='opencode'?['-s']:[])].includes(a))
  const nativeResume=resumeAt>=0 && !args[resumeAt+1]?.startsWith('-') ? args[resumeAt+1] : undefined
  const id=resumedTuiSession(bindings,nativeResume) ?? `tui:${randomUUID()}`,broker=new NativeChatClient(state,agentId,id,process.cwd(),'tui_prompt')
  const controller=new AbortController(),screen=new xterm.Terminal({cols:process.stdout.columns||100,rows:process.stdout.rows||30,scrollback:0,allowProposedApi:true})
  const child=pty.spawn(executable.command,[...executable.prefix,...invocation.args],{
    name:process.env.TERM||'xterm-256color',cols:screen.cols,rows:screen.rows,cwd:process.cwd(),
    env:{...env,AGENTHUB_TUI_BINDINGS:bindings,AGENTHUB_TUI_SESSION:id,AGENTHUB_TUI_AGENT:agentId,AGENTHUB_TUI_KEY:broker.key,...(executable.prefix.length?{ELECTRON_RUN_AS_NODE:'1'}:{})},
  })
  let stopQuotas:(()=>Promise<void>)|undefined
  let stopped=false,ready=false,injecting=false,pendingTurn=false,sawBusy=false,lastInput=0,lastOutput=0,userDraft=false,composerSeen=false
  let timer:ReturnType<typeof setTimeout>|undefined,listener:Promise<void>|undefined
  let events=Promise.resolve(),heldInput=''
  const waiters=new Set<()=>void>()
  const emit=(event:string)=>{events=events.then(()=>broker.send(event)).then(()=>{}).catch(()=>{})}
  const notify=()=>{for(const resolve of waiters)resolve();waiters.clear()}
  const inspect=()=>{
    clearTimeout(timer)
    if(stopped)return
    const b=screen.buffer.active,lines=Array.from({length:screen.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)??'')
    const empty=emptyTuiComposer(kind,lines,b.cursorY)
    if(empty)composerSeen=true
    if(pendingTurn && !empty)sawBusy=true
    if(pendingTurn && sawBusy && empty){pendingTurn=false;sawBusy=false}
    const quiet=Date.now()-lastInput>=750 && Date.now()-lastOutput>=150
    if(empty && quiet)userDraft=false
    const next=empty && quiet && !pendingTurn && !injecting
    if(next!==ready){ready=next;emit(ready?'Stop':pendingTurn?'HubPromptSubmit':'Interrupt');notify()}
    if(empty && !quiet)timer=setTimeout(inspect,750)
  }
  const input=(data:Buffer)=>{
    const text=data.toString('utf8')
    // Terminal query responses are not human prompts or drafts.
    const response=/^\x1b(?:\[\??[\d;>]*[Rcn]|\].*\x07)$/.test(text)
    if(!response){
      lastInput=Date.now()
      if(composerSeen && /[\r\n]/.test(text) && userDraft){pendingTurn=true;sawBusy=false;userDraft=false;composerSeen=false;emit('UserPromptSubmit')}
      else if(composerSeen && /[^\r\n\x00-\x1f]/.test(text))userDraft=true
      ready=false;notify()
    }
    if(injecting)heldInput+=text;else child.write(text)
    if(!response){clearTimeout(timer);timer=setTimeout(inspect,750)}
  }
  const resize=()=>{const cols=process.stdout.columns||100,rows=process.stdout.rows||30;screen.resize(cols,rows);child.resize(cols,rows);inspect()}
  const abort=()=>{if(!stopped){controller.abort();child.kill();notify()}}
  const closed=new Promise<number>(resolve=>child.onExit(e=>{stopped=true;controller.abort();notify();resolve(e.exitCode)}))
  child.onData(data=>{lastOutput=Date.now();process.stdout.write(data);screen.write(data,()=>{inspect();clearTimeout(timer);timer=setTimeout(inspect,200)})})
  const wasRaw=process.stdin.isRaw;process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',input)
  process.stdout.on('resize',resize);process.once('SIGTERM',abort);process.once('SIGHUP',abort)
  try {
    const deliver=async (text:string)=>{
      while(!stopped && !controller.signal.aborted) {
        inspect()
        if(ready)break
        await new Promise<void>(resolve=>waiters.add(resolve))
      }
      if(stopped || controller.signal.aborted)return
      // A delivery may have waited behind a draft while its recipient was removed.
      await broker.send('Heartbeat',controller.signal)
      inspect();if(!ready || stopped || controller.signal.aborted)return
      // No incoming message body is typed here: the broker sends only its own notification.
      injecting=true;ready=false;pendingTurn=true;sawBusy=false;emit('HubPromptSubmit')
      child.write(`\x1b[200~${text.replace(/[\x00-\x1f\x7f]/g,' ')}\x1b[201~`)
      await new Promise(resolve=>setTimeout(resolve,100))
      if(!stopped)child.write('\r')
      injecting=false
      if(heldInput && !stopped){child.write(heldInput);heldInput=''}
    }
    listener=(async()=>{
      while(!controller.signal.aborted){
        try {
          await broker.start();emit(ready?'Stop':'Interrupt')
          if(kind!=='claude_code' && !stopQuotas)stopQuotas=startQuotaCollector({root:state.root,cli:kind,command:executable.command,prefix:executable.prefix,args,cwd:process.cwd(),env,broker,signal:controller.signal})
          await broker.listen(deliver,controller.signal,false);return
        } catch(error) {
          // Missing authorization/workspace is not repaired by retrying. Keep the native UI usable.
          if(error instanceof ChatConnectionError && [401,403,404,409,410].includes(error.status)) {
            process.stderr.write(`\r\nAgent Hub: ${error.message}\r\n`);return
          }
          if(controller.signal.aborted)return
          await new Promise<void>(resolve=>{
            const done=()=>{clearTimeout(retry);controller.signal.removeEventListener('abort',done);resolve()}
            const retry=setTimeout(done,5000);controller.signal.addEventListener('abort',done,{once:true})
          })
        }
      }
    })()
    inspect()
    return await closed
  } finally {
    abort();clearTimeout(timer);notify();process.stdin.off('data',input);process.stdin.setRawMode(wasRaw);process.stdin.pause()
    process.stdout.off('resize',resize);process.off('SIGTERM',abort);process.off('SIGHUP',abort)
    await stopQuotas?.();await listener;await events;await broker.send('SessionEnd').catch(()=>{});screen.dispose()
  }
}
