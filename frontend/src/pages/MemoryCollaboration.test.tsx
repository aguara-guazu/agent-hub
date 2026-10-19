import { act } from 'react'
import { createRoot,type Root } from 'react-dom/client'
import { QueryClient,QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { installFetch,jsonResponse } from '../test-utils'
import { ProjectCollaboration } from './MemoryCollaboration'
let root:Root,container:HTMLDivElement,client:QueryClient,calls:any[],historical:boolean,removed:boolean,failKick:boolean
beforeEach(()=> {
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();calls=[];historical=false;removed=false;failKick=false
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container)
  client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})
  installFetch({handle:call=> {
    if(call.path==='/memory/chat/kick'){
      calls.push({operation:'ui_kick',input:call.body})
      if(failKick)return jsonResponse({error:'No se pudo expulsar'},403)
      removed=true;return jsonResponse({session:{id:'old-agent',state:'removed'}})
    }
    if(call.path!=='/memory/call')return
    const body=call.body as any;calls.push(body)
    const items=body.operation==='chat_channels'?[{id:'channel',name:'feature/review',path:'/project/worktree',branch:'review',threads:1,read_only:historical}]
      :body.operation==='chat_agents'?[{id:'old-agent',channel_id:'channel',label:'Bruma',state:removed?'removed':'offline',removed_at:removed?'2026-10-19T12:00:00Z':null,removal_reason:removed?'Retiro manual':null,capability:'codex_queue',last_seen_at:'2026-10-19T00:00:00Z'}]
      :body.operation==='chat_threads'?[{id:'thread',channel_id:'channel',title:'Revisión de suma',state:'open',channel_name:'feature/review',messages:1,preview:'Error en resta',updated_at:'2026-10-19T00:00:00Z'}]
      :[{id:'message',author_label:'Junco',text:'Error en resta <script>bad()</script>',created_at:'2026-10-19T00:00:00Z',mentions:[{recipient_id:'old-agent',label:'Bruma',notified_at:null,read_at:null,handled_at:null,attempts:0}]}]
    return jsonResponse({items,total:items.length,limit:40,offset:0,...(body.operation==='chat_read'?{thread:{id:'thread',channel_id:'channel',title:'Revisión de suma',state:'open'}}:{})})
  }})
})
afterEach(()=> {act(()=>root.unmount());client.clear();container.remove();vi.useRealTimers();vi.unstubAllGlobals()})
async function tick(){await act(async()=> {await vi.advanceTimersByTimeAsync(30)})}
async function mount(url='/?tab=collaboration'){await act(async()=>{root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><ProjectCollaboration projectId="project"/></MemoryRouter></QueryClientProvider>)});await tick();await tick()}
async function click(text:string){const button=[...container.querySelectorAll('button')].find(b=>b.textContent?.includes(text))!;expect(button).toBeTruthy();await act(async()=>button.click());await tick();await tick()}
it('permite recorrer canales e historial sin participar ni consumir mensajes',async()=> {
  await mount();expect(container.textContent).toContain('Chat de sólo lectura');expect(container.textContent).toContain('Desconectado')
  await click('# feature/review');expect(calls.some(c=>c.operation==='chat_threads'&&c.input.channel_id==='channel')).toBe(true)
  await click('Abrir hilo');expect(container.textContent).toContain('Error en resta <script>bad()</script>');expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('[aria-label="Hilos del canal"]')).toBeNull()
  expect(container.querySelector('[aria-label="Canales del proyecto"]')).not.toBeNull()
  expect(container.textContent).toContain('Junco');expect(container.textContent).toContain('@Bruma')
  expect(container.textContent).toContain('Pendiente');expect(container.querySelector('textarea')).toBeNull()
  expect(calls.every(c=>['chat_channels','chat_agents','chat_threads','chat_read'].includes(c.operation))).toBe(true)
  expect(calls.find(c=>c.operation==='chat_read').input.session_key).toBeUndefined()
  await click('Volver al canal');expect(container.querySelector('article')).toBeNull();expect(container.querySelector('[aria-label="Hilos del canal"]')).not.toBeNull()
})
it('permite filtrar por una identidad desconectada y sigue refrescando las lecturas',async()=> {
  await mount();await click('Bruma')
  expect(calls.some(c=>c.operation==='chat_threads'&&c.input.author_id==='old-agent')).toBe(true)
  await click('Quitar filtro de agente');expect(calls.at(-1).input.author_id).toBeUndefined()
  const count=calls.length;await act(async()=>{await vi.advanceTimersByTimeAsync(5100)});expect(calls.length).toBeGreaterThan(count)
})

it('conserva búsqueda, autor y página al entrar y volver al canal',async()=> {
  await mount('/?tab=collaboration&channel=channel&chat_q=suma&chat_author=old-agent&chat_state=open&chat_offset=30')
  await click('Abrir hilo');await click('Volver al canal')
  expect((container.querySelector('input[type=search]') as HTMLInputElement).value).toBe('suma')
  expect((container.querySelector('select') as HTMLSelectElement).value).toBe('open')
  expect(calls.filter(c=>c.operation==='chat_threads').at(-1).input).toMatchObject({channel_id:'channel',query:'suma',author_id:'old-agent',state:'open',offset:30})
})
it('abre un enlace directo al hilo y vuelve a su canal',async()=> {
  await mount('/?tab=collaboration&thread=thread')
  expect(container.querySelector('.local-chat-channels button.selected')?.textContent).toContain('feature/review')
  await click('Volver al canal')
  expect(calls.filter(c=>c.operation==='chat_threads').at(-1).input.channel_id).toBe('channel')
  expect(container.querySelector('article')).toBeNull()
})

it('identifica canales históricos sin impedir consultar sus mensajes',async()=> {
  historical=true
  await mount('/?tab=collaboration&channel=channel')
  expect(container.textContent).toContain('Histórico · sólo lectura')
  expect(container.textContent).toContain('Espacio no disponible')
  await click('Abrir hilo');expect(container.textContent).toContain('Error en resta')
})

it('expulsa manualmente sólo después de confirmar y conserva al autor en el historial',async()=>{
 await mount('/?channel=channel');await click('Expulsar del canal')
 expect(calls.some(c=>c.operation==='ui_kick')).toBe(false)
 const dialog=document.querySelector('[role=dialog]')!
 expect(dialog.textContent).toContain('Bruma');expect(dialog.textContent).toContain('terminal seguirá abierta')
 const confirm=[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Confirmar expulsión')!
 await act(async()=>confirm.click());await tick();await tick()
 expect(calls.find(c=>c.operation==='ui_kick').input).toEqual({project_id:'project',channel_id:'channel',participant_id:'old-agent',reason:'Expulsado por la persona desde la UI'})
 expect(document.querySelector('[role=dialog]')).toBeNull();expect(container.textContent).toContain('Expulsado')
 expect(container.querySelector('[aria-label="Expulsar a Bruma"]')).toBeNull()
 await click('Bruma');expect(calls.some(c=>c.operation==='chat_threads'&&c.input.author_id==='old-agent')).toBe(true)
})
it('cancelar no expulsa y los errores quedan visibles sin fingir éxito',async()=>{
 await mount();await click('Expulsar del canal')
 let dialog=document.querySelector('[role=dialog]')!
 await act(async()=>[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Cancelar')!.click());await tick()
 expect(calls.some(c=>c.operation==='ui_kick')).toBe(false)
 failKick=true;await click('Expulsar del canal');dialog=document.querySelector('[role=dialog]')!
 await act(async()=>[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Confirmar expulsión')!.click());await tick();await tick()
 expect(document.querySelector('[role=dialog] [role=alert]')).not.toBeNull()
 expect(container.querySelector('[aria-label="Expulsar a Bruma"]')).not.toBeNull()
})
