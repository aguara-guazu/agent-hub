import { expect, it } from 'vitest'
import { summarizeReplyTick } from '../src/service.js'
import type { ActionTickResult } from '../src/schedule-contract.js'

it('resume solo conteos y nombres de error y calla los ciclos sin actividad', () => {
  expect(summarizeReplyTick(undefined)).toBeNull()
  expect(summarizeReplyTick({ expired: 0, gmail: null, slack: { consumed: 0, seen: 0 } })).toBeNull()
  expect(summarizeReplyTick({ skipped: 'automations_off' })).toBeNull()
  expect(summarizeReplyTick({ expired: 2, gmail: { consumed: 1, inspected: 4, body: 'texto' }, slack: { error: 'TypeError' } })).toEqual({ expired: 2, gmail: { consumed: 1 }, errors: ['slack:TypeError'] })
  expect(summarizeReplyTick({ expired: 0, gmail: { inspected: 3, consumed: 0 }, slack: { inspected: 5 } })).toBeNull()
  expect(summarizeReplyTick({ slack: { inspected: 2, rejected: 1 } })).toEqual({ slack: { rejected: 1 } })
  expect(summarizeReplyTick({ gmail: { inspected: 2, rejected: { not_sent: 2, wrong_thread: 1 } }, slack: { rejected: {} } })).toEqual({ gmail: { rejected: 3 } })
})

it('el barrido de recuperación de la flota corre después de que el reloj registre los incidentes de reinicio, aunque el reloj falle', async () => {
  const { startClockThenRecover } = await import('../src/service.js')
  const order: string[] = []
  await startClockThenRecover({ start: async () => { await new Promise(resolve => setTimeout(resolve, 20)); order.push('reloj') } }, { recover: async () => { order.push('barrido') } })
  expect(order).toEqual(['reloj', 'barrido'])
  order.length = 0
  const quiet = (await import('vitest')).vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await startClockThenRecover({ start: async () => { throw new Error('falla') } }, { recover: async () => { order.push('barrido') } })
  expect(order).toEqual(['barrido'])
  await startClockThenRecover({ start: async () => undefined }, undefined)
  quiet.mockRestore()
})

it('el despachador deja evento solo cuando intentó algo y nunca al saltearse, con el tipo del contrato', async () => {
  const { summarizeActionTick } = await import('../src/service.js')
  const cycles: Array<[ActionTickResult | undefined, Record<string, unknown> | null]> = [
    [undefined, null],
    [{ attempted: 0, succeeded: 0, rejected: 0, uncertain: 0 }, null],
    [{ skipped: 'in_flight' }, null],
    [{ skipped: 'automations_off' }, null],
    [{ attempted: 3, succeeded: 2, rejected: 0, uncertain: 1 }, { attempted: 3, succeeded: 2, rejected: 0, uncertain: 1 }],
  ]
  for (const [result, expected] of cycles) expect(summarizeActionTick(result)).toEqual(expected)
})
