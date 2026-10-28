import { expect, it } from 'vitest'
import xterm from '@xterm/headless'
import { advanceTurn, busyHint, emptyTuiComposer, idleTurn, isTerminalReply, startTurn, stateEvent, tuiInvocation, tuiScreen, TURN_ACK_MS, TURN_SETTLE_MS, undimmedRow, withoutVirtualText } from './chat-tui.js'
it('passes native permission/model flags verbatim and selects the full Kiro UI',()=>{
 const args=['--trust-all-tools','--model','gpt-5.6-sol','--effort','high']
 expect(tuiInvocation('kiro',args)).toEqual({command:'kiro-cli',args:['chat','--tui',...args]})
 expect(tuiInvocation('codex_cli',['resume','abc','-a','never']).args).toEqual(['resume','abc','-a','never'])
})
it('recognizes the actual Kiro TUI with trust-all-tools without treating its status as a permission request',()=>{
 const lines=Array(40).fill('');lines[25]='Trust All Tools active, confirmations are off · /quit to exit';lines[29]='›  ask a question or describe a task ↵'
 expect(emptyTuiComposer('kiro',lines,29)).toBe(true)
 lines[29]='› un borrador';expect(emptyTuiComposer('kiro',lines,29)).toBe(false)
})
it('does not submit drafts, quoted prompts, working turns or permission menus',()=>{
 expect(emptyTuiComposer('codex_cli',['›'],0)).toBe(true)
 for(const lines of [['›','Permission required: allow once?'],['›','Thinking · esc to interrupt'],['› revisar mis archivos'],['❯']])expect(emptyTuiComposer('codex_cli',lines,0)).toBe(false)
 expect(emptyTuiComposer('codex_cli',['›',...Array(15).fill('')],15)).toBe(false)
 expect(emptyTuiComposer('opencode',['Ask anything con este borrador'],0)).toBe(false)
})
const rule='─'.repeat(100)
const screenOf=(rows:Record<number,string>,height=30)=>Array.from({length:height},(_,i)=>rows[i]??'')
it('ignores chat history above a Claude composer and keeps the spinner row as a busy marker',()=>{
 const reply='⏺ Plan listo. Confirmá el digest o elegí otra composición. thinking working.'
 const idle=screenOf({21:reply,22:'  Confirmá antes de seguir. Thinking… working. elegí',24:rule,25:'❯\xa0',26:rule,27:'  ⏵⏵ auto mode on (shift+tab to cycle)'})
 expect(tuiScreen('claude_code',idle,25)).toBe('empty')
 expect(emptyTuiComposer('claude_code',idle,25)).toBe(true)
 const spinner=screenOf({20:reply,22:'✻ Pondering… (12s · esc to interrupt)',24:rule,25:'❯\xa0',26:rule})
 expect(tuiScreen('claude_code',spinner,25)).toBe('other')
 expect(emptyTuiComposer('claude_code',screenOf({22:'⏺ Confirmá esto, thinking.',24:rule,25:'❯\xa0',26:rule,27:'  Thinking… working…'}),25)).toBe(false)
})
it('treats the suggested-prompt placeholder of OpenCode as an empty composer',()=>{
 const opencode=screenOf({14:'             ┃',15:'             ┃  Ask anything… "What is the tech stack of this project?"',16:'             ┃',17:'             ┃  Build · Big Pickle OpenCode',19:'                         tab agents  ctrl+p commands'})
 expect(emptyTuiComposer('opencode',opencode,15)).toBe(true)
 opencode[15]='             ┃  revisar el stack del proyecto';expect(emptyTuiComposer('opencode',opencode,15)).toBe(false)
})
it('reports permission dialogs and multi-line drafts as not ready',()=>{
 const permission=screenOf({20:' Bash command',21:'   ls -la',22:' Do you want to proceed?',23:' ❯ 1. Yes',24:'   2. No',26:' Esc to cancel · Tab to amend'})
 expect(tuiScreen('claude_code',permission,23)).toBe('dialog')
 expect(emptyTuiComposer('claude_code',permission,23)).toBe(false)
 const draft=screenOf({24:rule,25:'❯',26:'  segunda línea del borrador',27:rule})
 expect(emptyTuiComposer('claude_code',draft,26)).toBe(false)
 expect(emptyTuiComposer('claude_code',screenOf({24:rule,25:'❯ primera línea',26:'  segunda línea',27:rule}),26)).toBe(false)
})
it('does not accept a notification while an approval or spinner sits above a visible composer',()=>{
 const codex=screenOf({22:'Permission required: allow once · allow always · reject',26:'› Ask Codex to do anything',28:'  ? for shortcuts'})
 expect(tuiScreen('codex_cli',codex,26)).toBe('dialog')
 expect(emptyTuiComposer('codex_cli',codex,26)).toBe(false)
 const queued=screenOf({19:'✻ Pondering… (12s · esc to interrupt)',21:'  ❯ mensaje en cola',23:rule,24:'❯\xa0',25:rule})
 expect(emptyTuiComposer('claude_code',queued,24)).toBe(false)
})
it('detects the Claude spinner row drawn without an interrupt hint',()=>{
 const base={6:'❯ Escribí los números del 1 al 300 en palabras, uno por línea',24:rule,25:'❯\xa0',26:rule,29:'  ⏸ manual mode on'}
 for(const spinner of ['✳ Nucleating… (2s · thinking with medium effort)','✻ Razzmatazzing… (5s · ↓ 577 tokens · thought for 3s) '])
  expect(emptyTuiComposer('claude_code',screenOf({...base,22:spinner,23:'                         ◐ medium · /effort'}),25)).toBe(false)
 expect(emptyTuiComposer('claude_code',screenOf({...base,8:'⏺ Antes de empezar, una pregunta.',11:'✻ Brewed for 5s · done 2:24 PM'}),25)).toBe(true)
})
it('finds the Claude spinner above a task list',()=>{
 const tasks=screenOf({13:'✻ Razzmatazzing… (5s · ↓ 577 tokens · thought for 3s)',15:'  ☐ Crear módulo',16:'  ☐ Escribir pruebas',17:'  ☐ Revisar',24:rule,25:'❯\xa0',26:rule})
 expect(emptyTuiComposer('claude_code',tasks,25)).toBe(false)
 tasks[13]='✻ Worked for 1m 3s';expect(emptyTuiComposer('claude_code',tasks,25)).toBe(true)
})
it('does not take a quoted or finished Claude spinner row for a busy turn',()=>{
 const base={24:rule,25:'❯\xa0',26:rule}
 expect(emptyTuiComposer('claude_code',screenOf({...base,22:'  ✳ Nucleating… (2s · thinking with medium effort)'}),25)).toBe(true)
 expect(emptyTuiComposer('claude_code',screenOf({...base,22:'⏺ El spinner muestra ✳ Nucleating… (2s · thinking)'}),25)).toBe(true)
 expect(emptyTuiComposer('claude_code',screenOf({...base,22:'✻ Brewed for 5s · done 2:24 PM'}),25)).toBe(true)
 expect(emptyTuiComposer('claude_code',screenOf({...base,22:'✳ Nucleating… (2s · thinking with medium effort)'}),25)).toBe(false)
})
it('classifies the real Claude permission dialog and the composer after rejecting it',()=>{
 const dialog=screenOf({13:rule,14:' Bash command',15:' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',18:' mkdir -p /tmp/fix-detector-screens && ls -la /tmp/fix-detector-screens',20:' Do you want to proceed?',21:' ❯ 1. Yes',22:'   2. Yes, and allow access to /private/tmp/fix-detector-screens and mkdir -p',24:'   3. Yes, and switch to auto mode · auto mode handles these prompts for you',25:'   4. No',27:' Esc to cancel · Tab to amend'})
 expect(tuiScreen('claude_code',dialog,21)).toBe('dialog')
 const rejected=screenOf({9:'  Ran 1 shell command',10:'  ⎿ \xa0Interrupted · What should Claude do instead?',13:'  ⎿ \xa0User rejected write to /tmp/fix-detector-screens/prueba-permiso.txt',16:'✻ Crunched for 3s · done 2:35 PM',23:'                                                                                ◐ medium · /effort',24:rule,25:'❯\xa0',26:rule,29:'  ⏸ manual mode on'})
 expect(tuiScreen('claude_code',rejected,25)).toBe('empty')
})
it('takes the Claude spinner row without counter as a busy screen and reports what showed it',()=>{
 const base={24:rule,25:'❯\xa0',26:rule}
 for(const row of ['✢ Transmuting… ','✽ Incubating… ','✻ Pondering… ','✳ Nucleating… (2s · thinking with medium effort)','✻ Razzmatazzing… (5s · ↓ 577 tokens · thought for 3s) ','✶ Cooking up something… (1s)']){
  expect(emptyTuiComposer('claude_code',screenOf({...base,22:row}),25)).toBe(false)
  expect(busyHint(screenOf({...base,22:row}),25)).toBe('spinner')
 }
 for(const row of ['✻ Brewed for 5s · done 2:24 PM','✻ Cogitated for 1m 0s · done 3:00 PM · 2 shells still running','  ✢ Transmuting… ','⏺ Resumen: ✽ Incubating… luego sigue'])
  expect(busyHint(screenOf({...base,22:row}),25)).toBe(null)
 expect(busyHint(screenOf({...base,23:'  ⏵⏵ bypass permissions on · esc to interrupt'}),22)).toBe('interrupt')
})
it('does not take the echo of a submitted prompt or an unknown screen for work',()=>{
 const turn=startTurn(1000)
 const echo=advanceTurn(turn,false,null,false,1010)
 expect(echo.busyBy).toBe(null)
 const gap=advanceTurn(echo,true,null,true,1020)
 expect(gap.pending).toBe(true)
 expect(advanceTurn(gap,true,null,true,1500).pending).toBe(true)
 expect(advanceTurn(gap,true,null,true,2500).pending).toBe(true)
 expect(advanceTurn(gap,true,null,true,1000+TURN_ACK_MS).pending).toBe(false)
 expect(advanceTurn(turn,true,null,true,1000+TURN_ACK_MS-1).pending).toBe(true)
 expect(advanceTurn(turn,true,null,false,1000+TURN_ACK_MS).pending).toBe(true)
})
it('keeps a turn open through isolated empty frames and closes it once the composer settles after work',()=>{
 const busy=advanceTurn(startTurn(1000),false,'spinner',true,1500)
 expect(busy).toEqual({pending:true,busyBy:'spinner',since:1000,emptySince:null})
 const gap=advanceTurn(busy,true,null,true,2000)
 expect(gap.pending).toBe(true)
 expect(advanceTurn(gap,false,'spinner',true,2300).emptySince).toBe(null)
 expect(advanceTurn(gap,true,null,true,2000+TURN_SETTLE_MS-1).pending).toBe(true)
 expect(advanceTurn(gap,true,null,false,2000+TURN_SETTLE_MS).pending).toBe(true)
 expect(advanceTurn(gap,true,null,true,2000+TURN_SETTLE_MS).pending).toBe(false)
 expect(advanceTurn(idleTurn,false,'spinner',true,5)).toEqual(idleTurn)
})
const composerOf=async (data:string)=>{
 const term=new xterm.Terminal({cols:100,rows:6,scrollback:0,allowProposedApi:true})
 await new Promise<void>(resolve=>term.write(`\r\n\r\n\r\n\r\n${data}`,resolve))
 const b=term.buffer.active,row=undimmedRow(b.getLine(b.viewportY+b.cursorY))
 term.dispose()
 return row
}
it('reads the Claude composer without dimmed placeholder or suggestion text',async()=>{
 const dim=(text:string)=>`\x1b[2m${text}\x1b[22m`
 const lines=(row:string)=>screenOf({0:rule,1:row,2:rule},6)
 expect(emptyTuiComposer('claude_code',lines(await composerOf(`❯\xa0${dim('mostrá el estado del sleep en segundo plano')}\x1b[3G`)),1)).toBe(true)
 expect(emptyTuiComposer('claude_code',lines(await composerOf(`❯\xa0${dim('Try "how does routes.ts work?"')}`)),1)).toBe(true)
 expect(emptyTuiComposer('claude_code',lines(await composerOf('❯\xa0Try borrador escrito por la persona')),1)).toBe(false)
 expect(emptyTuiComposer('claude_code',lines(await composerOf(`❯\xa0hola ${dim('sugerencia')}`)),1)).toBe(false)
})
it('does not count terminal answers or focus events as typing',()=>{
 for(const reply of ['\x1bP>|xterm.js(6.0.0)\x1b\\','\x1b[?0u','\x1b[?2026;2$y','\x1b[?1;2c','\x1b[24;80R','\x1b[0n','\x1b[I','\x1b[O',
  '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\\x1b[?1;2c','\x1b[?1016;2$y\x1b[?1;2c','\x1b[?0u\x1b]7501;?:states=idle\x1b\\\x1b[?1;2c'])
  expect(isTerminalReply(reply)).toBe(true)
 for(const typed of ['','h','hola','\r','\x1b[A','\x1b[97;5u','\x1b[?0uhola','\x1b[200~texto\x1b[201~','\x1b'])expect(isTerminalReply(typed)).toBe(false)
})
it('tells placeholder and suggestion text from a draft by the cursor column',()=>{
 expect(withoutVirtualText('❯\xa0Try "fix typecheck errors"',2,false)).toBe('❯')
 expect(withoutVirtualText('❯\xa0mostrá el estado del sleep',2,false)).toBe('❯')
 expect(withoutVirtualText('❯\xa0Try "arreglar el build"',27,false)).toBe('❯\xa0Try "arreglar el build"')
 expect(withoutVirtualText('❯\xa0Try "arreglar el build"',2,true)).toBe('❯\xa0Try "arreglar el build"')
 expect(withoutVirtualText('❯\xa0',2,false)).toBe('❯\xa0')
 expect(withoutVirtualText('  texto de la respuesta',2,false)).toBe('  texto de la respuesta')
})
it('keeps the spaces between cursor-advanced words in a buffer row',async()=>{
 expect(await composerOf('❯\xa0Trabajá\x1b[1Csolo')).toBe('❯\xa0Trabajá solo')
})
it('keeps reporting a visible dialog as blocked while its frames redraw',()=>{
 expect(stateEvent(false,'dialog',true,true,'UserPromptSubmit')).toBe('Interrupt')
 expect(stateEvent(false,'dialog',false,true,'UserPromptSubmit')).toBe('')
 expect(stateEvent(false,'dialog',false,true,'Interrupt')).toBe('Interrupt')
 expect(stateEvent(false,'dialog',true,true,'Interrupt')).toBe('Interrupt')
 expect(stateEvent(false,'other',false,true,'Interrupt')).toBe('HubPromptSubmit')
 expect(stateEvent(false,'other',true,false,'Stop')).toBe('')
 expect(stateEvent(true,'empty',true,false,'Interrupt')).toBe('Stop')
})
