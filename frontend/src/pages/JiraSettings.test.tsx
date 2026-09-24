import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/Toast'
import { installFetch, jsonResponse } from '../test-utils'
import { JiraSettings } from './JiraSettings'
import { ProjectTasks } from './MemoryTasks'

let root:Root,container:HTMLDivElement,client:QueryClient
beforeEach(()=>{globalThis.IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})})
afterEach(()=>{act(()=>root.unmount());client.clear();container.remove();vi.useRealTimers();vi.unstubAllGlobals()})
async function tick(){await act(async()=>{await vi.advanceTimersByTimeAsync(30)})}
async function mount(element:ReactNode){await act(async()=>root.render(<QueryClientProvider client={client}><MemoryRouter><ToastProvider>{element}</ToastProvider></MemoryRouter></QueryClientProvider>));await tick();await tick()}
async function click(text:string){await act(async()=>{[...container.querySelectorAll('button')].find(b=>b.textContent===text)!.click()});await tick()}
const site='https://empresa.atlassian.net'
it('guarda y permite quitar el sitio global sin alterar la configuración de IA',async()=>{
  const mock=installFetch({handle:call=>jsonResponse(call.method==='PUT'?{default_site_url:null}:{default_site_url:site})})
  await mount(<JiraSettings/>);const input=container.querySelector('input')!;expect(input.value).toBe(site)
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}))})
  await act(async()=>{container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))});await tick()
  expect(mock.calls.find(c=>c.method==='PUT')).toMatchObject({path:'/memory/jira-settings',body:{default_site_url:null}})
  expect(mock.calls.some(c=>c.path==='/memory/ai')).toBe(false)
})
it.each([null,'https://propia.atlassian.net'])('muestra el sitio efectivo y guarda null al heredar: %s',async own=>{
  const mock=installFetch({handle:call=>call.path==='/memory/jira-settings'?jsonResponse({default_site_url:site}):jsonResponse({items:[],total:0,counts:[]})})
  await mount(<ProjectTasks project={{id:'p',kind:'project',title:'Proyecto',data:{jira_project_key:'APP',jira_site_url:own},created_at:'2026-09-24',updated_at:'2026-09-24'}}/>)
  expect(container.querySelector('.memory-jira-setup')!.textContent).toContain(own?'propia.atlassian.net':'empresa.atlassian.net (predeterminado)')
  await click('Configurar');if(own)await click('Usar sitio predeterminado')
  const url=container.querySelector<HTMLInputElement>('input[type="url"]')!;expect(url.value).toBe('');expect(url.placeholder).toBe(site)
  await act(async()=>{container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))});await tick()
  const saved=mock.calls.find(c=>(c.body as any)?.operation==='update_entity')
  expect((saved!.body as any).input.data).toEqual({jira_project_key:'APP',jira_site_url:null})
})
