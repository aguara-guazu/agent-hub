import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { installFetch, jsonResponse } from '../test-utils'
import { TeamPlan } from './TeamPlan'

it('shows the exact plan and permissions before approving its digest, then displays incorporation separately',async()=>{
  globalThis.IS_REACT_ACT_ENVIRONMENT=true
  const calls:any[]=[]
  const plan={id:'plan',digest:'a'.repeat(64),objective:'Resolver ticket',state:'prepared',parent:{path:'/context',kind:'virtual'},base_revision:'virtual',
    plan:{permissions:'full_access',members:[{id:'worker',role:'Implementación',task:'Resolver bug',prompt:'Aplicar cambios',cli:'claude_code',model:'model',effort:'medium'}]},
    progress:{workspaces_created:0,processes_accepted:0,joined:0,total:1}}
  installFetch({handle:call=>{
    calls.push(call)
    if(call.method==='POST')return jsonResponse({...plan,state:'launched',progress:{workspaces_created:1,processes_accepted:1,joined:0,total:1}})
    return jsonResponse(plan)
  }})
  const container=document.createElement('div'),root=createRoot(container),cache=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})
  document.body.append(container)
  try {
    await act(async()=>{root.render(<QueryClientProvider client={cache}><TeamPlan id="plan"/></QueryClientProvider>);await new Promise(r=>setTimeout(r,20))})
    await act(async()=>{await new Promise(r=>setTimeout(r,20))})
    expect(container.textContent).toContain('acceso completo')
    expect(container.textContent).toContain('No copian ni aíslan')
    expect(calls.some(c=>c.method==='POST')).toBe(false)
    const approve=[...container.querySelectorAll('button')].find(b=>b.textContent==='Aprobar e iniciar este equipo')!
    await act(async()=>{approve.click();await new Promise(r=>setTimeout(r,20))})
    expect(calls.find(c=>c.method==='POST').body).toEqual({digest:plan.digest})
    expect(container.textContent).toContain('Incorporados: 0/1')
  } finally {await act(async()=>root.unmount());cache.clear();container.remove();vi.unstubAllGlobals()}
})

it('does not confuse a busy process with delivery and opens the operator report where the peer conversation happened',async()=>{
 globalThis.IS_REACT_ACT_ENVIRONMENT=true
 const onThread=vi.fn(),container=document.createElement('div'),root=createRoot(container),cache=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})
 document.body.append(container)
 const member={id:'operator',nickname:'Operador',role:'Browser',task:'Reproducir el caso',cli:'claude_code',model:'small',state:'joined',work_thread_id:'task',runtime:{state:'busy'},work:null,last_report:{id:'report',thread_id:'peer',text:'Resultado de la reproducción',created_at:'2026-10-22T00:00:00Z'}}
 installFetch({handle:()=>jsonResponse({id:'plan',state:'launched',master_channel_id:'channel',root_thread_id:'root',parent:{path:'/context'},plan:{permissions:'full_access',members:[member]},members:[member],progress:{joined:1,processes_accepted:1,workspaces_created:1,total:1}})})
 try {
  await act(async()=>{root.render(<QueryClientProvider client={cache}><TeamPlan id="plan" compact onThread={onThread}/></QueryClientProvider>);await new Promise(r=>setTimeout(r,20))})
  await act(async()=>{await new Promise(r=>setTimeout(r,20))})
  expect(container.textContent).toContain('Proceso activo');expect(container.textContent).toContain('Con reporte')
  expect(container.textContent).not.toContain('Entrega reportada')
  const button=[...container.querySelectorAll('button')].find(b=>b.textContent==='Ver último reporte')!
  await act(async()=>button.click());expect(onThread).toHaveBeenCalledWith('peer','channel')
 } finally {await act(async()=>root.unmount());cache.clear();container.remove();vi.unstubAllGlobals()}
})
