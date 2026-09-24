import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/Toast'
import { installFetch, jsonResponse } from '../test-utils'
import { ProfileDraft, ProjectCompanyForm, SuggestedProjectSelect } from './MemoryAssistance'

let root:Root,container:HTMLDivElement,client:QueryClient
beforeEach(()=> {globalThis.IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})})
afterEach(()=>{act(()=>root.unmount());client.clear();container.remove();vi.useRealTimers();vi.unstubAllGlobals()})
async function tick(){await act(async()=>{await vi.advanceTimersByTimeAsync(30)})}
async function mount(element:React.ReactNode){await act(async()=>{root.render(<QueryClientProvider client={client}><MemoryRouter><ToastProvider>{element}</ToastProvider></MemoryRouter></QueryClientProvider>)});await tick();await tick()}
const project={id:'p1',title:'Ventas',kind:'project',data:{},created_at:'2026-09-24',updated_at:'2026-09-24T00:00:00Z'}
function Picker(){const [value,setValue]=useState('');return <SuggestedProjectSelect sourceId="s" value={value} onChange={setValue} label="Proyecto sugerido" />}
const draft={title:'Empresa sugerida',description:'Descripción del negocio.',warnings:[],coverage:{available_sources:3,sampled_sources:3},sources:[{id:'f',href:'/memory/entities/s?fragment=f',title:'Assessment',text:'Vendemos insumos.'}]}
async function click(text:string){await act(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent===text)!.click()});await tick()}

it('preselecciona la sugerencia sin guardar asociaciones',async()=>{
  const mock=installFetch({handle:call=>{const {operation}=call.body as any
    if(operation==='suggest_projects')return jsonResponse({items:[project],selected_id:'p1',semantic_status:'ready',reason:'Coincide con la empresa.'})
    if(operation==='get_entity')return jsonResponse({entity:project})
    return jsonResponse({items:[project],total:1})}})
  await mount(<Picker/>);expect(container.querySelector('select')!.value).toBe('p1')
  expect(mock.calls.some(c=>(c.body as any)?.operation==='link_entities')).toBe(false)
})
it('una respuesta tardía no reemplaza lo que la persona eligió',async()=>{
  let resolve!:(r:Response)=>void
  installFetch({handle:call=>{const {operation}=call.body as any
    if(operation==='suggest_projects')return new Promise<Response>(r=>{resolve=r})
    if(operation==='get_entity')return jsonResponse({entity:{...project,id:'manual'}})
    return jsonResponse({items:[{...project,id:'manual'}],total:1})}})
  await mount(<Picker/>);await act(async()=>{const select=container.querySelector('select')!;select.value='manual';select.dispatchEvent(new Event('change',{bubbles:true}))})
  await act(async()=>resolve(jsonResponse({items:[project],selected_id:'p1',semantic_status:'ready'})));await tick()
  expect(container.querySelector('select')!.value).toBe('manual')
})
it('crear empresa genera una preview; sólo guarda al confirmar el formulario',async()=>{
  const mock=installFetch({handle:call=>{const {operation}=call.body as any
    if(operation==='draft_profile')return jsonResponse(draft)
    if(operation==='save_project_company')return jsonResponse({company:{id:'c'}})
    return jsonResponse({items:[],total:0})}})
  const close=vi.fn();await mount(<ProjectCompanyForm project={project} onClose={close}/>);await click('Crear empresa');await tick()
  expect(document.body.textContent).toContain('Vista previa editable')
  expect(mock.calls.some(c=>(c.body as any)?.operation==='save_project_company')).toBe(false)
  await click('Usar borrador')
  expect(document.body.textContent).toContain('Aún falta guardar')
  await act(async()=>{document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))});await tick()
  const save=mock.calls.find(c=>(c.body as any)?.operation==='save_project_company')!
  expect((save.body as any).input).toEqual({project_id:'p1',expected_updated_at:project.updated_at,company:{title:draft.title,description:draft.description}})
  expect(close).toHaveBeenCalledOnce()
})
it('no cambia la descripción del editor hasta usar el borrador',async()=>{
  installFetch({handle:()=>jsonResponse(draft)});const use=vi.fn()
  await mount(<ProfileDraft projectId="p1" kind="project" onUse={use}/>);await click('Generar borrador con IA');await tick()
  expect(use).not.toHaveBeenCalled();await click('Usar borrador');expect(use).toHaveBeenCalledWith(expect.objectContaining({description:draft.description}))
})
