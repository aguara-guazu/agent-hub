import { act } from 'react'
import { createRoot,type Root } from 'react-dom/client'
import { QueryClient,QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { installFetch,jsonResponse } from '../test-utils'
import { ProjectCollaboration } from './MemoryCollaboration'
let root:Root,container:HTMLDivElement,client:QueryClient,calls:any[],historical:boolean,removed:boolean,failKick:boolean,agentTotal:number|null,staleActivity:boolean
beforeEach(()=> {
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();calls=[];historical=false;removed=false;failKick=false;agentTotal=null;staleActivity=false
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
      :body.operation==='chat_agents'?[
        {id:'old-agent',channel_id:'channel',label:'Bruma',cli_kind:'codex_cli',state:removed?'removed':staleActivity?'unknown':'offline',state_reason:staleActivity?'activity_stale':null,connection_state:staleActivity?'online':'offline',state_observed_at:'2026-10-18T23:00:00Z',removed_at:removed?'2026-10-19T12:00:00Z':null,removal_reason:removed?'Retiro manual':null,capability:'codex_queue',last_seen_at:'2026-10-19T00:00:00Z'},
        {id:'removed-at',channel_id:'channel',label:'Eco removido',cli_kind:'kiro',state:'offline',removed_at:'2026-10-18T12:00:00Z',capability:'tui_prompt',last_seen_at:'2026-10-18T00:00:00Z'},
        {id:'removed-state',channel_id:'channel',label:'Sombra removida',cli_kind:'kiro',state:'removed',removed_at:null,capability:'tui_prompt',last_seen_at:'2026-10-18T00:00:00Z'}]
      :body.operation==='chat_threads'?[{id:'thread',channel_id:'channel',title:'Revisión de suma',state:'open',channel_name:'feature/review',messages:1,preview:'Error en resta',updated_at:'2026-10-19T00:00:00Z'}]
      :[{id:'message',author_id:'author',author_label:'Junco',text:'Error en resta <script>bad()</script>',created_at:'2026-10-19T00:00:00Z',reply_to:null,mentions:[{recipient_id:'old-agent',label:'Bruma',notified_at:null,read_at:null,handled_at:null,attempts:0}]}]
    return jsonResponse({items,total:body.operation==='chat_agents' && agentTotal!==null?agentTotal:items.length,limit:40,offset:body.input.offset??0,...(body.operation==='chat_read'?{thread:{id:'thread',channel_id:'channel',title:'Revisión de suma',state:'open'}}:{})})
  }})
})
afterEach(()=> {act(()=>root.unmount());client.clear();container.remove();vi.useRealTimers();vi.unstubAllGlobals()})
async function tick(){await act(async()=> {await vi.advanceTimersByTimeAsync(30)})}
async function mount(url='/?tab=collaboration',unassigned=false){await act(async()=>{root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><ProjectCollaboration {...(unassigned ? {unassigned:true}:{projectId:'project'})}/></MemoryRouter></QueryClientProvider>)});await tick();await tick()}
async function click(text:string){const button=[...container.querySelectorAll('button')].find(b=>b.textContent?.includes(text))!;expect(button).toBeTruthy();await act(async()=>button.click());await tick();await tick()}
it('distingue conexión reciente de actividad sin confirmar',async()=>{
  staleActivity=true
  await mount();await click('Mostrar agentes')
  const panel=container.querySelector('[aria-label="Agentes vigentes"]')!
  expect(panel.textContent).toContain('Actividad sin confirmar')
  expect(panel.textContent).toContain('La conexión sigue activa; no confirma que esté trabajando.')
  expect(panel.textContent).not.toContain('Trabajando')
  expect(panel.querySelector('.local-chat-agent-profile')!.getAttribute('title')).toContain('Último estado observado:')
})
it('permite recorrer canales e historial sin participar ni consumir mensajes',async()=> {
  await mount();expect(container.textContent).toContain('Chat de sólo lectura');expect(container.querySelector('[aria-label="Agentes vigentes"]')).toBeNull()
  await click('Mostrar agentes');expect(container.textContent).toContain('Desconectado')
  await click('# feature/review');expect(calls.some(c=>c.operation==='chat_threads'&&c.input.channel_id==='channel')).toBe(true)
  await click('Abrir hilo');expect(container.textContent).toContain('Error en resta <script>bad()</script>');expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('[aria-label="Hilos del canal"]')).toBeNull()
  expect(container.querySelector('[aria-label="Canales del proyecto"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="Agentes vigentes"]')).not.toBeNull()
  expect(container.textContent).toContain('Junco');expect(container.textContent).toContain('@Bruma')
  expect(container.textContent).toContain('Pendiente');expect(container.querySelector('textarea')).toBeNull()
  expect(calls.every(c=>['chat_channels','chat_agents','chat_threads','chat_read'].includes(c.operation))).toBe(true)
  expect(calls.find(c=>c.operation==='chat_read').input.session_key).toBeUndefined()
  await click('Volver al canal');expect(container.querySelector('article')).toBeNull();expect(container.querySelector('[aria-label="Hilos del canal"]')).not.toBeNull()
})
it('oculta el panel inicialmente, excluye expulsados por fecha o estado y permite volver a ocultarlo',async()=> {
  await mount();expect(container.querySelector('[aria-label="Agentes vigentes"]')).toBeNull()
  const show=[...container.querySelectorAll('button')].find(button=>button.textContent?.includes('Mostrar agentes'))!
  expect(show.getAttribute('aria-expanded')).toBe('false')
  await click('Mostrar agentes')
  const panel=container.querySelector('[aria-label="Agentes vigentes"]')!
  expect(panel.textContent).toContain('Bruma');expect(panel.textContent).not.toContain('Eco removido');expect(panel.textContent).not.toContain('Sombra removida')
  expect([...container.querySelectorAll('button')].find(button=>button.textContent?.includes('Ocultar agentes'))?.getAttribute('aria-expanded')).toBe('true')
  await click('Ocultar agentes');expect(container.querySelector('[aria-label="Agentes vigentes"]')).toBeNull()
})
it('permite filtrar por una identidad desconectada y sigue refrescando las lecturas',async()=> {
  await mount();await click('Mostrar agentes');await click('Bruma')
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
  await click('Mostrar agentes');expect(container.querySelector('[aria-label="Agentes vigentes"]')).not.toBeNull()
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

it('expulsa manualmente sólo después de confirmar, lo quita de vigentes y conserva el historial',async()=>{
 await mount('/?channel=channel');await click('Mostrar agentes');await click('Expulsar del canal')
 expect(calls.some(c=>c.operation==='ui_kick')).toBe(false)
 const dialog=document.querySelector('[role=dialog]')!
 expect(dialog.textContent).toContain('Bruma');expect(dialog.textContent).toContain('terminal seguirá abierta')
 const confirm=[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Confirmar expulsión')!
 await act(async()=>confirm.click());await tick();await tick()
 expect(calls.find(c=>c.operation==='ui_kick').input).toEqual({project_id:'project',channel_id:'channel',participant_id:'old-agent',reason:'Expulsado por la persona desde la UI'})
 expect(document.querySelector('[role=dialog]')).toBeNull();expect(container.querySelector('[aria-label="Agentes vigentes"]')?.textContent).not.toContain('Bruma')
 expect(container.textContent).toContain('No hay agentes vigentes')
 await click('Abrir hilo');expect(container.textContent).toContain('Junco');expect(container.textContent).toContain('@Bruma');expect(container.textContent).toContain('Error en resta')
})
it('cancelar no expulsa y los errores quedan visibles sin fingir éxito',async()=>{
 await mount();await click('Mostrar agentes');await click('Expulsar del canal')
 let dialog=document.querySelector('[role=dialog]')!
 await act(async()=>[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Cancelar')!.click());await tick()
 expect(calls.some(c=>c.operation==='ui_kick')).toBe(false)
 failKick=true;await click('Expulsar del canal');dialog=document.querySelector('[role=dialog]')!
 await act(async()=>[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Confirmar expulsión')!.click());await tick();await tick()
 expect(document.querySelector('[role=dialog] [role=alert]')).not.toBeNull()
 expect(container.querySelector('[aria-label="Expulsar a Bruma"]')).not.toBeNull()
})

it('consulta colaboración sin proyecto y permite expulsar sin inventar una asociación',async()=>{
 await mount('/?channel=channel',true)
 expect(container.querySelector('[aria-label="Canales sin proyecto"]')).not.toBeNull()
 for(const operation of ['chat_channels','chat_agents','chat_threads']) {
   const input=calls.find(c=>c.operation===operation).input
   expect(input.unassigned).toBe(true)
   expect(input.project_id).toBeUndefined()
 }
 await click('Mostrar agentes');await click('Expulsar del canal')
 const dialog=document.querySelector('[role=dialog]')!
 await act(async()=>[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Confirmar expulsión')!.click());await tick();await tick()
 expect(calls.find(c=>c.operation==='ui_kick').input).toEqual({channel_id:'channel',participant_id:'old-agent',reason:'Expulsado por la persona desde la UI'})
 await click('Abrir hilo')
 const input=calls.find(c=>c.operation==='chat_read').input
 expect(input.project_id).toBeUndefined()
 expect(input.unassigned).toBeUndefined()
 expect(container.textContent).toContain('Error en resta')
})

it('usa el total paginado de agentes vigentes y vuelve a la primera página después de expulsar',async()=>{
 agentTotal=81
 await mount('/?channel=channel&agent_offset=80')
 expect(container.textContent).toContain('Mostrar agentes (81)')
 await click('Mostrar agentes');await click('Expulsar del canal')
 const dialog=document.querySelector('[role=dialog]')!
 await act(async()=>[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Confirmar expulsión')!.click());await tick();await tick()
 expect(calls.filter(c=>c.operation==='chat_agents').at(-1).input.offset).toBe(0)
})
