import { afterEach,expect,it,vi } from 'vitest'
import { inspectNativeProcess, isStableProcessStart } from './native-process.js'

const {exec,readFile}=vi.hoisted(()=>({exec:vi.fn(),readFile:vi.fn()}))
vi.mock('node:util',async original=>({...await original<typeof import('node:util')>(),promisify:()=>exec}))
vi.mock('node:fs/promises',async original=>({...await original<typeof import('node:fs/promises')>(),readFile}))
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

it.skipIf(process.platform==='linux')('consulta la hora de inicio con el locale neutro para que el texto no dependa del idioma del sistema',async()=>{
  exec.mockResolvedValueOnce({stdout:'1 Wed Oct 28 21:00:00 2026 node server.js\n'})
  expect(await inspectNativeProcess(123)).toMatchObject({parent:1,started:'Wed Oct 28 21:00:00 2026'})
  if(process.platform!=='win32')expect(exec.mock.calls[0]![2].env).toMatchObject({LC_ALL:'C'})
})

const stat=(ticks:string)=>`123 (node (x) y) S 1 123 123 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 1000 10 18446744073709551615`
const proc=(ticks:string)=>readFile.mockImplementation(async(path:string)=>path.endsWith('boot_id')?'b0a7-1d\n':stat(ticks))

it.runIf(process.platform==='linux')('en Linux usa boot_id y starttime de /proc: el texto de ps lstart se corre en WSL2 aunque el PID siga vivo',async()=>{
  proc('4242')
  exec.mockResolvedValueOnce({stdout:'1 Tue Nov  3 00:11:27 2026 claude --continue\n'})
  const first=await inspectNativeProcess(123)
  exec.mockResolvedValueOnce({stdout:'1 Tue Nov  3 00:11:50 2026 claude --continue\n'})
  const later=await inspectNativeProcess(123)
  expect(first).toEqual({parent:1,started:'linux:b0a7-1d:4242',command:'claude --continue'})
  expect(later?.started).toBe(first?.started)
  expect(isStableProcessStart(first?.started)).toBe(true)
  expect(isStableProcessStart('Tue Nov  3 00:11:27 2026')).toBe(false)
  expect(exec.mock.calls[0]![2].env).toMatchObject({LC_ALL:'C'})
})

it.runIf(process.platform==='linux')('en Linux un PID reutilizado tiene otra identidad y sin /proc la inspección queda no disponible',async()=>{
  proc('4242');exec.mockResolvedValueOnce({stdout:'1 Tue Nov  3 00:11:27 2026 claude\n'})
  const original=await inspectNativeProcess(123)
  proc('9999');exec.mockResolvedValueOnce({stdout:'1 Tue Nov  3 00:11:27 2026 otro\n'})
  expect((await inspectNativeProcess(123))?.started).not.toBe(original?.started)
  readFile.mockRejectedValue(Object.assign(new Error('missing'),{code:'ENOENT'}))
  exec.mockResolvedValueOnce({stdout:'1 Tue Nov  3 00:11:27 2026 claude\n'})
  expect(await inspectNativeProcess(123)).toBeUndefined()
})
