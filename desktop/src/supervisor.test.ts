import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { CoreSupervisor, type SpawnFn, type SpawnedProcess } from './supervisor.js'

class FakeProcess extends EventEmitter implements SpawnedProcess {
  killed: NodeJS.Signals | null = null
  constructor(public readonly pid: number | undefined = 4242) {
    super()
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = signal
    return true
  }
}

function fakeSpawn(): { spawnFn: SpawnFn; procs: FakeProcess[] } {
  const procs: FakeProcess[] = []
  const spawnFn: SpawnFn = () => {
    const proc = new FakeProcess(1000 + procs.length)
    procs.push(proc)
    return proc
  }
  return { spawnFn, procs }
}

const noSleep = (): Promise<void> => Promise.resolve()

describe('CoreSupervisor', () => {
  it('arranca el core y expone estado running y pid', () => {
    const { spawnFn, procs } = fakeSpawn()
    const sup = new CoreSupervisor({ command: 'node', args: ['core.js'], spawnFn, sleepFn: noSleep })
    const states: string[] = []
    sup.on('state', (s) => states.push(s))
    sup.start()
    expect(sup.state).toBe('running')
    expect(sup.pid).toBe(procs[0]!.pid)
    expect(states).toEqual(['starting', 'running'])
  })

  it('pasa el entorno inyectado además de process.env', () => {
    const spawnFn = vi.fn<SpawnFn>(() => new FakeProcess())
    const sup = new CoreSupervisor({ command: 'node', args: ['core.js'], env: { AGENTHUB_HUB_PORT: '8765' }, spawnFn })
    sup.start()
    const env = spawnFn.mock.calls[0]![2]
    expect(env.AGENTHUB_HUB_PORT).toBe('8765')
    expect(env.PATH).toBe(process.env.PATH)
  })

  it('reinicia ante caída inesperada y respeta el máximo', async () => {
    const { spawnFn, procs } = fakeSpawn()
    const sup = new CoreSupervisor({
      command: 'node',
      args: ['core.js'],
      spawnFn,
      sleepFn: noSleep,
      maxRestarts: 2,
    })
    const errors: Error[] = []
    sup.on('error', (e) => errors.push(e))
    sup.start()

    // Tres caídas: reinicia dos veces y a la tercera falla.
    procs[0]!.emit('exit', 1, null)
    await Promise.resolve()
    procs[1]!.emit('exit', 1, null)
    await Promise.resolve()
    procs[2]!.emit('exit', 1, null)
    await Promise.resolve()

    expect(procs).toHaveLength(3)
    expect(sup.state).toBe('failed')
    expect(errors.at(-1)?.message).toMatch(/reinicios/)
  })

  it('no reinicia cuando la caída viene de un stop ordenado', async () => {
    const { spawnFn, procs } = fakeSpawn()
    const sup = new CoreSupervisor({ command: 'node', args: ['core.js'], spawnFn, sleepFn: noSleep })
    sup.start()
    const stopping = sup.stop()
    procs[0]!.emit('exit', 0, 'SIGTERM')
    await stopping
    expect(procs[0]!.killed).toBe('SIGTERM')
    expect(sup.state).toBe('stopped')
    expect(procs).toHaveLength(1)
  })

  it('escala a SIGKILL si el core no responde al SIGTERM', async () => {
    const { spawnFn, procs } = fakeSpawn()
    const sleeps: number[] = []
    const sup = new CoreSupervisor({
      command: 'node',
      args: ['core.js'],
      spawnFn,
      stopGraceMs: 10,
      sleepFn: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
    })
    sup.start()
    const stopping = sup.stop()
    // No emitimos 'exit' tras SIGTERM: el grace vence y el flujo escala a
    // SIGKILL. Dejamos correr los microtasks para que la carrera resuelva a
    // 'timeout' y se envíe el SIGKILL antes de simular la salida.
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    expect(procs[0]!.killed).toBe('SIGKILL')
    procs[0]!.emit('exit', null, 'SIGKILL')
    await stopping
    expect(sleeps).toContain(10)
    expect(sup.state).toBe('stopped')
  })

  it('stop sin proceso vivo queda stopped sin error', async () => {
    const { spawnFn } = fakeSpawn()
    const sup = new CoreSupervisor({ command: 'node', args: ['core.js'], spawnFn })
    await sup.stop()
    expect(sup.state).toBe('stopped')
  })

  it('marca failed si el spawn lanza', () => {
    const sup = new CoreSupervisor({
      command: 'node',
      args: ['core.js'],
      spawnFn: () => {
        throw new Error('ENOENT')
      },
    })
    const errors: Error[] = []
    sup.on('error', (e) => errors.push(e))
    sup.start()
    expect(sup.state).toBe('failed')
    expect(errors[0]?.message).toBe('ENOENT')
  })
})
