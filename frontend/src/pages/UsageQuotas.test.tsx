import { act } from 'react'
import { createRoot,type Root } from 'react-dom/client'
import { QueryClient,QueryClientProvider } from '@tanstack/react-query'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { installFetch,jsonResponse } from '../test-utils'
import { UsageQuotas } from './UsageQuotas'

let root:Root,container:HTMLDivElement,client:QueryClient,response:any
beforeEach(()=>{
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers()
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container)
  client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});response={clis:[]}
  installFetch({handle:call=>call.path==='/memory/call'?jsonResponse(response):undefined})
})
afterEach(()=>{act(()=>root.unmount());client.clear();container.remove();vi.useRealTimers();vi.unstubAllGlobals()})
async function mount(){await act(async()=>{root.render(<QueryClientProvider client={client}><UsageQuotas clients={[{id:'codex',cli_kind:'codex_cli'}]}/></QueryClientProvider>)});await act(async()=>{await vi.advanceTimersByTimeAsync(50)})}
it('no muestra disponible por falta de datos ni toma el saldo de otro cliente',async()=>{
  response={clis:[{cli:'codex_cli',status:'available',pools:[{id:'pool',binding_ids:['other'],status:'available'}]}]}
  await mount();expect(container.textContent).toContain('Cuota desconocida');expect(container.textContent).not.toContain('Cuota disponible')
  expect(container.querySelector('.hub-state.on')).toBeNull()
})
it('identifica un perfil y muestra agotamiento y antigüedad sin ocultar el límite vigente',async()=>{
  response={clis:[{cli:'codex_cli',status:'exhausted',pools:[{id:'pool',pool_id:'codex',scope:'account',binding_ids:['codex:profile:'+'a'.repeat(64)],status:'exhausted',stale:true,
    observation:{source:{adapter:'codex-app-server'},expires_at:'2026-10-20T10:05:00Z',observed_at:'2026-10-20T10:00:00Z',windows:[{id:'weekly',unit:'percent',used:100,resets_at:'2026-10-24T10:00:00Z'}]}}]}]}
  await mount();expect(container.textContent).toContain('Cuota agotada');expect(container.textContent).toContain('100 % usado')
  expect(container.textContent).toContain('lectura pendiente de actualización');expect(container.textContent).toContain('Reinicio informado')
  expect(container.querySelector('.hub-state.on')).toBeNull()
})

it('muestra porcentajes, fuente y ventanas específicas sin fingir disponibilidad global',async()=>{
 const observation={source:{adapter:'claude-control'},observed_at:'2026-10-22T20:00:00Z',expires_at:'2026-10-22T20:05:00Z',windows:[{id:'five_hour',unit:'percent',used:18,duration_minutes:300,resets_at:'2026-10-22T23:00:00Z'}]}
 const base={scope:'binding',binding_ids:['codex'],status:'available',observation}
 response={clis:[{cli:'codex_cli',status:'unknown',reason:'unknown_model_scope',pools:[{...base,id:'one',pool_id:'subscription'},{...base,id:'two',pool_id:'model-fable',status:'unknown',reason:'unknown_model_scope'}]}]}
 await mount()
 for(const text of ['Lectura parcial','Cuota general','Ventana específica: fable','5 horas','18 % usado','Fuente: Claude Code · consulta nativa','Válida hasta'])expect(container.textContent).toContain(text)
 expect(container.querySelector('.hub-state.on')).toBeNull()
})
