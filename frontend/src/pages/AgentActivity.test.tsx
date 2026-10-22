import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installFetch, jsonResponse, type FetchMock } from '../test-utils'
import { AgentActivity } from './AgentActivity'
let root:Root,container:HTMLDivElement,mock:FetchMock,generation:string,supported:boolean
const item=(seq:number,text:string)=>({seq,at:'2026-10-22T00:00:00Z',kind:'tool',text})
beforeEach(()=>{
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();generation='first';supported=true
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container)
  mock=installFetch({handle:call=>{
    if(!call.path.endsWith('/activity'))return
    const after=Number(new URL(call.url,'http://localhost').searchParams.get('after'))
    return jsonResponse({supported,generation,items:!supported?[]:generation==='first'?(after===0?[item(1,'<script>private output</script>')]:[item(2,'second command')]):after===0?[item(1,'new conversation')]:[],next_cursor:generation==='first'?(after===0?1:2):1})
  }})
})
afterEach(()=>{act(()=>root.unmount());container.remove();vi.useRealTimers();vi.unstubAllGlobals()})
async function tick(ms=30){await act(async()=>{await vi.advanceTimersByTimeAsync(ms)})}
async function mount(){await act(async()=>root.render(<AgentActivity agent={{id:'test-agent',label:'Prueba'}} onClose={()=>root.render(null)} onMessages={()=>{}}/>));await tick()}
it('loads escaped output only while open, appends new events once and never sends commands',async()=>{
  expect(mock.calls).toHaveLength(0);await mount()
  expect(document.body.textContent).toContain('<script>private output</script>');expect(document.querySelector('script')).toBeNull()
  await tick(2100);await tick(2100)
  expect(document.querySelectorAll('.agent-activity-item')).toHaveLength(2)
  expect(mock.calls[1].url).toContain('after=1');expect(mock.calls[2].url).toContain('after=2')
  expect(mock.calls.every(call=>call.method==='GET')).toBe(true)
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="Cerrar"]')!.click());const count=mock.calls.length
  await tick(5000);expect(mock.calls).toHaveLength(count);expect(document.querySelector('[role=dialog]')).toBeNull()
})
it('restarts at the beginning of a new process generation without mixing conversations',async()=>{
  await mount();generation='second';await tick(2100)
  expect(mock.calls.at(-1)?.url).toContain('after=0')
  expect(document.body.textContent).toContain('new conversation');expect(document.body.textContent).not.toContain('private output')
})
it('external sessions explain missing transport and do not poll',async()=>{
  supported=false;await mount();expect(document.body.textContent).toContain('no comparte su salida')
  const count=mock.calls.length;await tick(5000);expect(mock.calls).toHaveLength(count)
})
