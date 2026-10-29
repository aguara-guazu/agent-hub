import { afterEach,expect,it,vi } from 'vitest'
import { inspectNativeProcess } from './native-process.js'

const {exec}=vi.hoisted(()=>({exec:vi.fn()}))
vi.mock('node:util',async original=>({...await original<typeof import('node:util')>(),promisify:()=>exec}))
afterEach(()=>vi.resetAllMocks())

it('cancela la consulta del sistema sin interpretar la cancelación como salida del agente',async()=>{
  const controller=new AbortController()
  exec.mockImplementation(async(_command,_args,options)=>new Promise((_resolve,reject)=>{
    options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{code:1})),{once:true})
  }))
  const pending=inspectNativeProcess(123,controller.signal)
  expect(exec.mock.calls[0]![2].signal).toBe(controller.signal)
  controller.abort()
  expect(await pending).toBeUndefined()
  expect(await inspectNativeProcess(123,controller.signal)).toBeUndefined()
  expect(exec).toHaveBeenCalledTimes(1)
})

it('conserva la distinción entre proceso ausente e inspección no disponible',async()=>{
  exec.mockResolvedValueOnce({stdout:''})
  expect(await inspectNativeProcess(123)).toBeNull()
  exec.mockRejectedValueOnce(Object.assign(new Error('timeout'),{code:'ETIMEDOUT'}))
  expect(await inspectNativeProcess(123)).toBeUndefined()
})

it('consulta la hora de inicio con el locale neutro para que el texto no dependa del idioma del sistema',async()=>{
  exec.mockResolvedValueOnce({stdout:'1 Wed Oct 28 21:00:00 2026 node server.js\n'})
  expect(await inspectNativeProcess(123)).toMatchObject({parent:1,started:'Wed Oct 28 21:00:00 2026'})
  if(process.platform!=='win32')expect(exec.mock.calls[0]![2].env).toMatchObject({LC_ALL:'C'})
})
