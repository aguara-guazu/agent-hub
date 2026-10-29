import { expect, it } from 'vitest'
import { summarizeReplyTick } from '../src/service.js'

it('resume solo conteos y nombres de error y calla los ciclos sin actividad', () => {
  expect(summarizeReplyTick(undefined)).toBeNull()
  expect(summarizeReplyTick({ expired: 0, gmail: null, slack: { consumed: 0, seen: 0 } })).toBeNull()
  expect(summarizeReplyTick({ skipped: 'automations_off' })).toBeNull()
  expect(summarizeReplyTick({ expired: 2, gmail: { consumed: 1, seen: 4, body: 'texto' }, slack: { error: 'TypeError' } })).toEqual({ expired: 2, gmail: { consumed: 1, seen: 4 }, errors: ['slack:TypeError'] })
})
