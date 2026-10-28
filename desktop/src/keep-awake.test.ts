import { describe, expect, it } from 'vitest'
import { KeepAwake, type KeepAwakeDeps } from './keep-awake.js'

function harness(maxHoldMs = 1000) {
  const started: number[] = []
  const stopped: number[] = []
  const timers = new Map<number, { callback: () => void; ms: number }>()
  let nextBlocker = 1
  let nextTimer = 1
  const deps: KeepAwakeDeps = {
    blocker: { start: () => { started.push(nextBlocker); return nextBlocker++ }, stop: id => { stopped.push(id) } },
    setTimer: (callback, ms) => { const id = nextTimer++; timers.set(id, { callback, ms }); return id },
    clearTimer: handle => { timers.delete(handle as number) },
    maxHoldMs,
  }
  return { keepAwake: new KeepAwake(deps), started, stopped, timers }
}

describe('KeepAwake', () => {
  it('toma un solo bloqueo para varias razones y lo suelta con la última', () => {
    const { keepAwake, started, stopped } = harness()
    keepAwake.hold('run-1')
    keepAwake.hold('run-2')
    expect(started).toEqual([1])
    expect(keepAwake.active).toBe(true)
    keepAwake.release('run-1')
    expect(stopped).toEqual([])
    keepAwake.release('run-2')
    expect(stopped).toEqual([1])
    expect(keepAwake.active).toBe(false)
  })

  it('renovar una razón reinicia su tope sin duplicar el bloqueo', () => {
    const { keepAwake, started, timers } = harness()
    keepAwake.hold('run-1')
    keepAwake.hold('run-1')
    expect(started).toEqual([1])
    expect(timers.size).toBe(1)
  })

  it('suelta la razón cuando vence su tope', () => {
    const { keepAwake, stopped, timers } = harness(500)
    keepAwake.hold('run-1')
    const [timer] = [...timers.values()]
    expect(timer!.ms).toBe(500)
    timer!.callback()
    expect(keepAwake.active).toBe(false)
    expect(stopped).toEqual([1])
  })

  it('liberar una razón desconocida no hace nada', () => {
    const { keepAwake, stopped } = harness()
    keepAwake.release('nunca-existió')
    expect(stopped).toEqual([])
  })

  it('sync libera lo que ya no figura, mantiene lo vigente y suelta todo con una lista vacía', () => {
    const { keepAwake, started, stopped } = harness()
    keepAwake.sync(['a', 'b'])
    keepAwake.sync(['b'])
    expect(keepAwake.active).toBe(true)
    expect(started).toEqual([1])
    keepAwake.sync([])
    expect(keepAwake.active).toBe(false)
    expect(stopped).toEqual([1])
  })

  it('sync no renueva el tope de una razón que sigue vigente', () => {
    const { keepAwake, timers } = harness()
    keepAwake.sync(['a'])
    const [before] = [...timers.keys()]
    keepAwake.sync(['a'])
    expect([...timers.keys()]).toEqual([before])
  })

  it('una razón vencida no se vuelve a tomar mientras el core la siga listando', () => {
    const { keepAwake, started, timers } = harness()
    keepAwake.sync(['a'])
    ;[...timers.values()][0]!.callback()
    expect(keepAwake.active).toBe(false)
    keepAwake.sync(['a'])
    expect(keepAwake.active).toBe(false)
    expect(started).toEqual([1])
    keepAwake.sync([])
    keepAwake.sync(['a'])
    expect(started).toEqual([1, 2])
  })

  it('dispose suelta el bloqueo', () => {
    const { keepAwake, stopped, timers } = harness()
    keepAwake.hold('run-1')
    keepAwake.dispose()
    expect(stopped).toEqual([1])
    expect(timers.size).toBe(0)
  })
})
