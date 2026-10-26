import { act } from 'react'
import { createRoot,type Root } from 'react-dom/client'
import { QueryClient,QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { installFetch,jsonResponse } from '../test-utils'
import { ProjectCollaboration } from './MemoryCollaboration'
let stoppedMember=false
let root:Root,container:HTMLDivElement,client:QueryClient,calls:any[],historical:boolean,removed:boolean,failKick:boolean,agentTotal:number|null,staleActivity:boolean,reverseOrder:boolean,withPlan:boolean,trashed:boolean
beforeEach(()=> {
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();calls=[];stoppedMember=false;historical=false;removed=false;failKick=false;agentTotal=null;staleActivity=false;reverseOrder=false;withPlan=false;trashed=false
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container)
  client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})
  installFetch({handle:call=> {
    if(call.path==='/memory/chat/channels/delete'){calls.push({operation:'ui_delete',input:call.body});trashed=true;return jsonResponse({uncertain_members:[]})}
    if(call.path==='/memory/chat/channels/restore'){calls.push({operation:'ui_restore',input:call.body});trashed=false;return jsonResponse({channel:{id:'channel'}})}
    if(call.path==='/memory/chat/coordinator'){calls.push({operation:'ui_coordinator',input:call.body});return jsonResponse({uncertain_members:[]})}
    if(call.path==='/memory/chat/kick'){
      calls.push({operation:'ui_kick',input:call.body})
      if(failKick)return jsonResponse({error:'No se pudo expulsar'},403)
      removed=true;return jsonResponse({session:{id:'old-agent',state:'removed'}})
    }
    if(call.path==='/memory/teams/preferences')return jsonResponse({preferred_backend:'hub'})
    if(call.path==='/memory/teams/plan')return jsonResponse({id:'plan',digest:'a'.repeat(64),objective:'Resolver ticket',state:'prepared',parent:{path:'/project/worktree'},base_revision:'b'.repeat(40),plan:{permissions:'full_access',members:[{id:'member',role:'Implementar',task:'Corregir bug',prompt:'Trabajo',cli:'claude_code',model:'model'}]},progress:{workspaces_created:0,processes_accepted:0,joined:0,total:1}})
    if(call.path.includes('/activity'))return jsonResponse({supported:false,items:[],next_cursor:0})
    if(call.path!=='/memory/call')return
    const body=call.body as any;calls.push(body)
    const items:any[]=body.operation==='chat_channels'?[{id:'channel',name:'feature/review',path:'/project/worktree',branch:'review',threads:1,read_only:historical,...(withPlan?{team_plan_id:'plan'}:{})}]
      :body.operation==='chat_agents'?[
        {id:'old-agent',channel_id:'channel',label:'Bruma',cli_kind:'codex_cli',nickname:'Bruma',created_at:'2026-10-18T00:00:00Z',state:removed?'removed':staleActivity?'unknown':'idle',state_reason:staleActivity?'activity_stale':null,connection_state:staleActivity?'online':'offline',state_observed_at:'2026-10-18T23:00:00Z',removed_at:removed?'2026-10-19T12:00:00Z':null,removal_reason:removed?'Retiro manual':null,capability:'codex_queue',last_seen_at:'2026-10-19T00:00:00Z'},
        {id:'removed-at',channel_id:'channel',label:'Eco removido',cli_kind:'kiro',state:'offline',removed_at:'2026-10-18T12:00:00Z',capability:'tui_prompt',last_seen_at:'2026-10-18T00:00:00Z'},
        {id:'removed-state',channel_id:'channel',label:'Sombra removida',cli_kind:'kiro',state:'removed',removed_at:null,capability:'tui_prompt',last_seen_at:'2026-10-18T00:00:00Z'}]
      :body.operation==='chat_threads'?[{id:'thread',channel_id:'channel',title:'Revisión de suma',state:'open',...(withPlan?{team_plan_id:'plan',team_plan_state:'prepared'}:{}),channel_name:'feature/review',messages:1,preview:'Error en resta',updated_at:'2026-10-19T00:00:00Z'}]
      :[{id:'message',author_id:'author',author_label:'Junco',text:'Error en resta <script>bad()</script>',created_at:'2026-10-19T00:00:00Z',reply_to:null,mentions:[{recipient_id:'old-agent',label:'Bruma',notified_at:null,read_at:null,handled_at:null,attempts:0}]}]
    if(body.operation==='chat_channels' && !!body.input.deleted!==trashed)items.splice(0)
    if(body.operation==='chat_agents') {
      if(stoppedMember)items.push({id:'worker',channel_id:'child',nickname:'Operador',label:'Operador',cli_kind:'codex_cli',state:'offline',closed_at:'2026-10-22',team_id:'plan',team_state:'cancelled',team_role:'Navegación',master_channel_id:'channel',work_thread_id:'thread',last_seen_at:'2026-10-22T00:00:00Z'})
      items.push({id:'pending',channel_id:'channel',label:'session-id',needs_nickname:true,state:'idle'}, {id:'closed',label:'Cerrado',closed_at:'2026-10-22',state:'idle'})
      if(reverseOrder)items.unshift({id:'second',channel_id:'channel',nickname:'Segundo',label:'Segundo',created_at:'2026-10-19T00:00:00Z',state:'busy',cli_kind:'codex_cli',last_seen_at:'2026-10-22T00:00:00Z'})
    }
    return jsonResponse({items,total:body.operation==='chat_agents' && agentTotal!==null?agentTotal:items.length,limit:40,offset:body.input.offset??0,...(body.operation==='chat_read'?{thread:{id:'thread',channel_id:'channel',title:'Revisión de suma',state:'open',...(withPlan?{team_plan_id:'plan',team_plan_state:'prepared'}:{})}}:{})})
  }})
})
afterEach(()=> {act(()=>root.unmount());client.clear();container.remove();vi.useRealTimers();vi.unstubAllGlobals()})
async function tick(){await act(async()=> {await vi.advanceTimersByTimeAsync(30)})}
async function mount(url='/?tab=collaboration',unassigned=false){await act(async()=>{root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><ProjectCollaboration {...(unassigned ? {unassigned:true}:{projectId:'project'})}/></MemoryRouter></QueryClientProvider>)});await tick();await tick()}
async function click(text:string){const button=[...document.querySelectorAll('button')].find(b=>b.textContent?.includes(text)||b.getAttribute('aria-label')===text)!;expect(button).toBeTruthy();await act(async()=>button.click());await tick();await tick()}
it('distingue conexión reciente de actividad sin confirmar',async()=>{
  staleActivity=true
  await mount();await click('Mostrar agentes')
  const panel=container.querySelector('[aria-label="Agentes del canal y sus equipos"]')!
  expect(panel.textContent).toContain('Actividad sin confirmar')
  expect(panel.querySelector('.local-chat-agent-profile')!.getAttribute('title')).toContain('La conexión sigue activa; no confirma que esté trabajando.')
  expect(panel.textContent).not.toContain('Trabajando')
  expect(panel.querySelector('.local-chat-agent-profile')!.getAttribute('title')).toContain('Último estado observado:')
})
it('permite recorrer canales e historial sin participar ni consumir mensajes',async()=> {
  await mount();expect(container.textContent).toContain('Chat de sólo lectura');expect(container.querySelector('[aria-label="Agentes del canal y sus equipos"]')).toBeNull()
  await click('Mostrar agentes');expect(container.textContent).toContain('Disponible')
  await click('# feature/review');expect(calls.some(c=>c.operation==='chat_threads'&&c.input.channel_id==='channel')).toBe(true)
  await click('Abrir hilo');expect(container.textContent).toContain('Error en resta <script>bad()</script>');expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('[aria-label="Hilos del canal"]')).toBeNull()
  expect(container.querySelector('[aria-label="Canales del proyecto"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="Agentes del canal y sus equipos"]')).not.toBeNull()
  expect(container.textContent).toContain('Junco');expect(container.textContent).toContain('@Bruma')
  expect(container.textContent).toContain('Pendiente');expect(container.querySelector('textarea')).toBeNull()
  expect(calls.every(c=>['chat_channels','chat_agents','chat_threads','chat_read'].includes(c.operation))).toBe(true)
  expect(calls.find(c=>c.operation==='chat_read').input.session_key).toBeUndefined()
  await click('Volver al canal');expect(container.querySelector('article')).toBeNull();expect(container.querySelector('[aria-label="Hilos del canal"]')).not.toBeNull()
})
it('oculta el panel inicialmente, excluye expulsados por fecha o estado y permite volver a ocultarlo',async()=> {
  await mount();expect(container.querySelector('[aria-label="Agentes del canal y sus equipos"]')).toBeNull()
  const show=[...container.querySelectorAll('button')].find(button=>button.textContent?.includes('Mostrar agentes'))!
  expect(show.getAttribute('aria-expanded')).toBe('false')
  await click('Mostrar agentes')
  const panel=container.querySelector('[aria-label="Agentes del canal y sus equipos"]')!
  expect(panel.textContent).toContain('Bruma');expect(panel.textContent).not.toContain('Eco removido');expect(panel.textContent).not.toContain('Sombra removida');expect(panel.textContent).not.toContain('session-id');expect(panel.textContent).not.toContain('Cerrado')
  expect([...container.querySelectorAll('button')].find(button=>button.textContent?.includes('Ocultar agentes'))?.getAttribute('aria-expanded')).toBe('true')
  await click('Ocultar agentes');expect(container.querySelector('[aria-label="Agentes del canal y sus equipos"]')).toBeNull()
})
it('permite inspeccionar una identidad y filtrar sus mensajes y sigue refrescando las lecturas',async()=> {
  await mount();await click('Mostrar agentes');await click('Bruma');await click('Ver mensajes en el Hub')
  expect(calls.some(c=>c.operation==='chat_threads'&&c.input.author_id==='old-agent')).toBe(true)
  await click('Quitar filtro de agente');expect(calls.at(-1).input.author_id).toBeUndefined()
  const count=calls.length;await act(async()=>{await vi.advanceTimersByTimeAsync(5100)});expect(calls.length).toBeGreaterThan(count)
})

it('conserva búsqueda, autor y página al entrar y volver al canal',async()=> {
  await mount('/?tab=collaboration&channel=channel&chat_q=suma&chat_author=old-agent&chat_state=open&chat_offset=30')
  await click('Abrir hilo');await click('Volver al canal')
  expect((container.querySelector('input[type=search]') as HTMLInputElement).value).toBe('suma')
  expect(([...container.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='open')) as HTMLSelectElement).value).toBe('open')
  expect(calls.filter(c=>c.operation==='chat_threads').at(-1).input).toMatchObject({channel_id:'channel',query:'suma',author_id:'old-agent',state:'open',offset:30})
})
it('abre un enlace directo al hilo y vuelve a su canal',async()=> {
  await mount('/?tab=collaboration&thread=thread')
  expect(container.querySelector('.local-chat-channels button.selected')?.textContent).toContain('feature/review')
  await click('Mostrar agentes');expect(container.querySelector('[aria-label="Agentes del canal y sus equipos"]')).not.toBeNull()
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
 await mount('/?channel=channel');await click('Mostrar agentes');await click('Expulsar a Bruma')
 expect(calls.some(c=>c.operation==='ui_kick')).toBe(false)
 const dialog=document.querySelector('[role=dialog]')!
 expect(dialog.textContent).toContain('Bruma');expect(dialog.textContent).toContain('terminal seguirá abierta')
 const confirm=[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Confirmar expulsión')!
 await act(async()=>confirm.click());await tick();await tick()
 expect(calls.find(c=>c.operation==='ui_kick').input).toEqual({project_id:'project',channel_id:'channel',participant_id:'old-agent',reason:'Expulsado por la persona desde la UI'})
 expect(document.querySelector('[role=dialog]')).toBeNull();expect(container.querySelector('[aria-label="Agentes del canal y sus equipos"]')?.textContent).not.toContain('Bruma')
 expect(container.textContent).toContain('No hay participantes visibles')
 await click('Abrir hilo');expect(container.textContent).toContain('Junco');expect(container.textContent).toContain('@Bruma');expect(container.textContent).toContain('Error en resta')
})
it('cancelar no expulsa y los errores quedan visibles sin fingir éxito',async()=>{
 await mount();await click('Mostrar agentes');await click('Expulsar a Bruma')
 let dialog=document.querySelector('[role=dialog]')!
 await act(async()=>[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Cancelar')!.click());await tick()
 expect(calls.some(c=>c.operation==='ui_kick')).toBe(false)
 failKick=true;await click('Expulsar a Bruma');dialog=document.querySelector('[role=dialog]')!
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
 await click('Mostrar agentes');await click('Expulsar a Bruma')
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
 await click('Mostrar agentes');await click('Expulsar a Bruma')
 const dialog=document.querySelector('[role=dialog]')!
 await act(async()=>[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Confirmar expulsión')!.click());await tick();await tick()
 expect(calls.filter(c=>c.operation==='chat_agents').at(-1).input.offset).toBe(0)
})

it('mantiene el orden de registro aunque la respuesta se ordene por actividad',async()=>{
  reverseOrder=true;await mount();await click('Mostrar agentes')
  const names=()=>[...container.querySelectorAll('.local-chat-agent-profile strong')].map(node=>node.textContent)
  expect(names()).toEqual(['Bruma','Segundo'])
  staleActivity=true;await act(async()=>{await vi.advanceTimersByTimeAsync(5100)})
  expect(names()).toEqual(['Bruma','Segundo'])
})

it('designates a connected coordinator only after the owner confirms the selected channel',async()=>{
  staleActivity=true
  await mount('/?channel=channel');await click('Mostrar agentes');await click('Designar coordinador')
  expect(calls.some(c=>c.operation==='ui_coordinator')).toBe(false)
  const dialog=document.querySelector('[role=dialog]')!
  expect(dialog.textContent).toContain('equipos anteriores quedarán pausados')
  await act(async()=>[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Designar esta sesión')!.click())
  await tick();await tick()
  expect(calls.find(c=>c.operation==='ui_coordinator').input).toEqual({channel_id:'channel',participant_id:'old-agent',expected_leader_id:null})
})

it('offers the prepared team from its channel and thread without a pasted plan URL or launching on read',async()=>{
  withPlan=true
  await mount('/?tab=collaboration&channel=channel')
  expect(container.querySelector('[aria-label="Plan del equipo"]')).toBeNull()
  await click('Revisar y aprobar equipo')
  expect(container.querySelector('[aria-label="Plan del equipo"]')?.textContent).toContain('Resolver ticket')
  expect(container.textContent).toContain('Aprobar e iniciar este equipo')
  expect(calls.every(c=>!c.operation?.startsWith('team_'))).toBe(true)
  await click('Conversaciones')
  await click('Abrir hilo')
  expect(container.querySelector('[aria-label="Plan del equipo"]')).toBeNull()
  await click('Revisar y aprobar equipo')
  expect(container.querySelector('[aria-label="Plan del equipo"]')).not.toBeNull()
})

it('confirms channel removal and allows restoring its history from trash',async()=>{
  await mount('/?tab=collaboration&channel=channel')
  await click('Eliminar canal')
  expect(calls.some(c=>c.operation==='ui_delete')).toBe(false)
  expect(document.body.textContent).toContain('Los archivos y worktrees se conservan')
  await click('Mover a la papelera')
  expect(calls.find(c=>c.operation==='ui_delete').input.channel_id).toBe('channel')
  await click('Papelera')
  expect(calls.some(c=>c.operation==='chat_channels' && c.input.deleted===true)).toBe(true)
  expect(container.textContent).toContain('No reactiva sesiones ni equipos')
  await click('Restaurar historial')
  expect(calls.find(c=>c.operation==='ui_restore').input).toEqual({channel_id:'channel'})
})

 it('conserva miembros desconectados con su estado real y acceso a su conversación',async()=>{
  stoppedMember=true
  await mount('/?channel=channel');await click('Mostrar agentes')
  const panel=container.querySelector('[aria-label="Agentes del canal y sus equipos"]')!
  expect(panel.textContent).toContain('Operador')
  expect(panel.textContent).toContain('Desconectado')
  expect(panel.textContent).toContain('Equipo cerrado')
  expect(panel.textContent).not.toContain('Trabajando')
  expect(calls.find(c=>c.operation==='chat_agents').input.include_team_history).toBe(true)
  expect(panel.querySelector('[aria-label="Expulsar a Operador"]')).toBeNull()
  await click('Ver conversación')
  expect(calls.filter(c=>c.operation==='chat_read').at(-1).input.thread_id).toBe('thread')
 })
