import { expect, it } from 'vitest'
import { emptyTuiComposer, tuiInvocation } from './chat-tui.js'
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
