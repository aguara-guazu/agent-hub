import { describe, expect, it } from 'vitest'
import { ClockWake } from './clock-wake.js'

function harness(wake: () => Promise<void> = async () => undefined) {
  let wakes = 0
  const timers = new Map<number, { callback: () => void; ms: number }>()
  let next = 1
  const clock = new ClockWake({
    wake: async () => { wakes += 1; await wake() },
    setTimer: (callback, ms) => { const id = next++; timers.set(id, { callback, ms }); return id },
    clearTimer: handle => { timers.delete(handle as number) },
    settleMs: 3000,
  })
  return { clock, timers, wakes: () => wakes }
}

describe('ClockWake', () => {
  it('agrupa una ráfaga de eventos en un solo aviso', () => {
    const { clock, timers, wakes } = harness()
    clock.trigger()
    clock.trigger()
    clock.trigger()
    expect(timers.size).toBe(1)
    const [timer] = [...timers.values()]
    expect(timer!.ms).toBe(3000)
    timer!.callback()
    expect(wakes()).toBe(1)
  })

  it('un evento posterior al aviso programa uno nuevo', () => {
    const { clock, timers, wakes } = harness()
    clock.trigger()
    ;[...timers.values()][0]!.callback()
    timers.clear()
    clock.trigger()
    ;[...timers.values()][0]!.callback()
    expect(wakes()).toBe(2)
  })

  it('absorbe el fallo del aviso', async () => {
    const { clock, timers } = harness(async () => { throw new Error('core caído') })
    clock.trigger()
    expect(() => [...timers.values()][0]!.callback()).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it('dispose cancela el aviso pendiente', () => {
    const { clock, timers, wakes } = harness()
    clock.trigger()
    clock.dispose()
    expect(timers.size).toBe(0)
    expect(wakes()).toBe(0)
  })
})
