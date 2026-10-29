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

// Accented letters are not `\b` word characters, so «Confirmá» would match `\bconfirm\b`.
const INTERRUPT_HINT=/(?:esc|ctrl.?c)\s+(?:to\s+)?(?:interrupt|cancel)|kiro is working/i
// Claude Code 2.1.312 draws `✳ Nucleating… (2s · thinking with medium effort)` without an interrupt hint,
// with the task list possibly between the spinner row and the composer, and appears first without the
// counter (`✢ Transmuting… `). Anchored to column 0: history rows are indented or start with a bullet, and a
// finished turn (`✻ Brewed for 5s`) has no ellipsis, so neither matches.
const SPINNER_HINT=/^[^\s\p{L}\p{N}⏺❯] [\p{L}\p{M}'’-]+(?: [\p{L}\p{M}'’-]+){0,3}…(?:\s*$| \()/mu
const DIALOG_HINT=/permission (?:requested|required)|allow once|trust this|approve (?:this|once)|do you trust|do you want to proceed|(?:enter|↵)\s+to\s+confirm/i
const STATUS_HINT=/(?<![\p{L}\p{N}_])(?:thinking|working[.…]|confirm(?![\p{L}\p{N}_]))/iu

interface TuiCell {getChars():string,getWidth():number,isDim():number}
interface TuiRow {readonly length:number,getCell(x:number):TuiCell|undefined}

/**
 * Text of a buffer row with dim cells blanked. Claude Code draws its placeholder and prompt suggestion
 * dimmed in the composer, whereas text typed by the person never is.
 */
export function undimmedRow(row:TuiRow|undefined):string {
  let text=''
  for(let x=0;row && x<row.length;x++) {
    const cell=row.getCell(x)
    if(!cell)break
    // A wide character's trailing cell has no column of its own; an empty cell of width 1 is a blank.
    if(cell.getWidth()===0)continue
    const chars=cell.getChars()
    text+=cell.isDim()!==0 || chars===''?' ':chars
  }
  return text.trimEnd()
}

/**
 * Placeholder and prompt suggestion text is drawn after the prompt with the cursor still at its first
 * column, whereas typed text moves the cursor past it. Not every theme renders it dimmed.
 */
export function withoutVirtualText(row:string,cursorX:number,typed:boolean):string {
  const prompt=/^(\s*❯\s)\S/.exec(row)?.[1]
  return prompt!==undefined && !typed && cursorX<=prompt.length?prompt.trimEnd():row
}

const TERMINAL_REPLY=/\x1bP[^\x1b]*\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[(?:\d+(?:;\d+)*R|[?>][\d;]*c|\d*n|\?[\d;]*n|\?[\d;:]*u|\?[\d;]*\$y|[IO])/g

/**
 * Whether a stdin chunk is made only of terminal answers or focus events (DCS, OSC, CPR, DA, DECRPM,
 * kitty keyboard status), which the host terminal sends unprompted and are not typing by the person.
 */
export function isTerminalReply(text:string):boolean {
  return text.length>0 && text.replace(TERMINAL_REPLY,'')===''
}

/**
 * Classifies the visible native screen. Chat history is rendered above the composer, so the rows above
 * it only contribute the specific interrupt and approval phrases; generic status words are read from
 * the composer row downwards. An approval drawn above a visible composer must still block injection.
 */
export function tuiScreen(kind:string,lines:string[],cursorY:number):'empty'|'dialog'|'other' {
  const footer=lines.slice(Math.max(0,cursorY),cursorY+7).join('\n')
  const dialogs=lines.slice(Math.max(0,cursorY-5),cursorY+7).join('\n')
  const patterns:Record<string,RegExp>={
    kiro:/^\s*›\s+ask a question or describe a task\s*↵?\s*$/i,
    codex_cli:/^\s*›\s*(?:Ask Codex to do anything|Find and fix a bug in @filename|Explain this codebase|Write tests for @filename|Summarize recent commits|Implement \{feature\}|Improve documentation in @filename)?\s*$/i,
    claude_code:/^\s*❯\s*$/,
    gemini_cli:/^[\s│┃]*>\s*(?:Type your message or @path\/to\/file|Type your message|Ask Gemini)?\s*[│┃]?\s*$/i,
    opencode:/^[\s┃│]*(?:Ask anything(?:…|\.\.\.)?(?:\s+".*")?|>)\s*[┃│]?\s*$/,
    antigravity:/^\s*[›>]\s*(?:Ask anything|Type your message)?\s*$/i,
  }
  const pattern=patterns[kind]
  // Use the cursor's composer, never a prompt quoted in chat history. A neighbouring row only counts
  // when the cursor row holds no text, otherwise it is the continuation of a multi-line draft.
  const cursorBlank=!/[\p{L}\p{N}]/u.test(lines[cursorY]??'')
  const composer=pattern!==undefined && lines.some((line,index)=>(index===cursorY || (cursorBlank && Math.abs(index-cursorY)===1)) && pattern.test(line))
  if(DIALOG_HINT.test(dialogs))return 'dialog'
  if(!composer)return 'other'
  return busyHint(lines,cursorY)!==null || STATUS_HINT.test(footer)?'other':'empty'
}

/** Positive evidence that the CLI is working: an interrupt hint or the spinner row, never a bare unknown screen. */
export function busyHint(lines:string[],cursorY:number):'spinner'|'interrupt'|null {
  const near=lines.slice(Math.max(0,cursorY-5),cursorY+7).join('\n')
  if(INTERRUPT_HINT.test(near))return 'interrupt'
  return SPINNER_HINT.test(lines.slice(Math.max(0,cursorY-12),Math.max(0,cursorY)).join('\n'))?'spinner':null
}

/** Only recognized, empty native composers accept a notification. Unknown screens defer. */
export function emptyTuiComposer(kind:string,lines:string[],cursorY:number):boolean {
  return tuiScreen(kind,lines,cursorY)==='empty'
}

/** Longest a submitted turn may go without the native UI ever showing a busy screen. */
export const TURN_ACK_MS=10000
/** How long the composer must stay empty before a turn that showed a busy screen is considered over. */
export const TURN_SETTLE_MS=2000

export interface TuiTurn {pending:boolean,busyBy:'spinner'|'interrupt'|null,since:number,emptySince:number|null}

export const idleTurn:TuiTurn={pending:false,busyBy:null,since:0,emptySince:null}
export const startTurn=(now:number):TuiTurn=>({pending:true,busyBy:null,since:now,emptySince:null})

/**
 * A turn closes when the composer has stayed empty after positive evidence of work (spinner or interrupt
 * hint). Frames without a spinner row occur between tool calls, and the echo of the submitted prompt is not
 * work. A CLI whose busy screen is not recognized, or that discarded the input, is closed by `TURN_ACK_MS`.
 */
export function advanceTurn(turn:TuiTurn,empty:boolean,busyBy:'spinner'|'interrupt'|null,quiet:boolean,now:number):TuiTurn {
  if(!turn.pending)return turn
  const seen=turn.busyBy ?? busyBy
  if(!empty)return {...turn,busyBy:seen,emptySince:null}
  const emptySince=turn.emptySince ?? now
  if(quiet && (seen ? now-emptySince>=TURN_SETTLE_MS : now-turn.since>=TURN_ACK_MS))return {...idleTurn,since:turn.since}
  return {...turn,busyBy:seen,emptySince}
}

/**
 * Event reporting the visible state to the Hub. A dialog keeps its 'Interrupt' while it stays on screen:
 * its frames may redraw, and quietness only gates the first report.
 */
export function stateEvent(ready:boolean,view:'empty'|'dialog'|'other',quiet:boolean,pending:boolean,reported:string):string {
  if(ready)return 'Stop'
  if(view==='dialog' && (quiet || reported==='Interrupt'))return 'Interrupt'
  return pending && reported!=='UserPromptSubmit'?'HubPromptSubmit':''
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
  let stopped=false,ready=false,injecting=false,turn:TuiTurn=idleTurn,lastInput=0,lastOutput=0,userDraft=false,composerSeen=false,inputSinceBlank=false,reported=''
  let timer:ReturnType<typeof setTimeout>|undefined,listener:Promise<void>|undefined
  let events=Promise.resolve(),heldInput=''
  const waiters=new Set<()=>void>()
  const emit=(event:string)=>{reported=event;events=events.then(()=>broker.send(event)).then(()=>{}).catch(()=>{})}
  const notify=()=>{for(const resolve of waiters)resolve();waiters.clear()}
  const inspect=()=>{
    clearTimeout(timer)
    if(stopped)return
    const b=screen.buffer.active
    // Any input since the composer was last blank makes its text a draft, wherever the cursor is.
    if(kind==='claude_code' && /^\s*❯\s*$/.test(b.getLine(b.viewportY+b.cursorY)?.translateToString(true)??''))inputSinceBlank=false
    const lines=Array.from({length:screen.rows},(_,i)=>kind==='claude_code' && i===b.cursorY?withoutVirtualText(undimmedRow(b.getLine(b.viewportY+i)),b.cursorX,inputSinceBlank):b.getLine(b.viewportY+i)?.translateToString(true)??'')
    const view=tuiScreen(kind,lines,b.cursorY),empty=view==='empty'
    if(empty)composerSeen=true
    const quiet=Date.now()-lastInput>=750 && Date.now()-lastOutput>=150
    turn=advanceTurn(turn,empty,busyHint(lines,b.cursorY),quiet,Date.now())
    if(empty && quiet)userDraft=false
    const next=empty && quiet && !turn.pending && !injecting
    // A momentary lack of quiet or a draft keeps the last reported state; only a dialog reports a block.
    const event=stateEvent(next,view,quiet,turn.pending,reported)
    if(event && event!==reported)emit(event)
    if(next!==ready){ready=next;notify()}
    if(!next && (empty && !quiet || view==='dialog' || turn.pending || reported==='Interrupt'))timer=setTimeout(inspect,empty && !quiet?750:2000)
  }
  const input=(data:Buffer)=>{
    const text=data.toString('utf8')
    // Terminal query responses are not human prompts or drafts.
    const response=isTerminalReply(text)
    if(!response){
      lastInput=Date.now();inputSinceBlank=true
      if(composerSeen && /[\r\n]/.test(text) && userDraft){turn=startTurn(Date.now());userDraft=false;composerSeen=false;emit('UserPromptSubmit')}
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
      // The broker marks a delivery as notified when it hands it over: it has to be injected eventually.
      for(;;) {
        while(!stopped && !controller.signal.aborted) {
          inspect()
          if(ready)break
          const retry=setTimeout(notify,2000)
          await new Promise<void>(resolve=>waiters.add(resolve))
          clearTimeout(retry)
        }
        if(stopped || controller.signal.aborted)return
        // A delivery may have waited behind a draft while its recipient was removed.
        await broker.send('Heartbeat',controller.signal)
        inspect()
        if(ready || stopped || controller.signal.aborted)break
      }
      if(stopped || controller.signal.aborted)return
      // No incoming message body is typed here: the broker sends only its own notification.
      injecting=true;ready=false;turn=startTurn(Date.now());emit('HubPromptSubmit')
      child.write(`\x1b[200~${text.replace(/[\x00-\x1f\x7f]/g,' ')}\x1b[201~`)
      await new Promise(resolve=>setTimeout(resolve,100))
      if(!stopped)child.write('\r')
      turn=startTurn(Date.now())
      injecting=false
      if(heldInput && !stopped){child.write(heldInput);heldInput=''}
    }
    listener=(async()=>{
      while(!controller.signal.aborted){
        try {
          await broker.start();reported='';inspect()
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
