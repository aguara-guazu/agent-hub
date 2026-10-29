import { expect, it } from 'vitest'
import { summarizeReplyTick } from '../src/service.js'

it('resume solo conteos y nombres de error y calla los ciclos sin actividad', () => {
  expect(summarizeReplyTick(undefined)).toBeNull()
  expect(summarizeReplyTick({ expired: 0, gmail: null, slack: { consumed: 0, seen: 0 } })).toBeNull()
  expect(summarizeReplyTick({ skipped: 'automations_off' })).toBeNull()
  expect(summarizeReplyTick({ expired: 2, gmail: { consumed: 1, inspected: 4, body: 'texto' }, slack: { error: 'TypeError' } })).toEqual({ expired: 2, gmail: { consumed: 1 }, errors: ['slack:TypeError'] })
  expect(summarizeReplyTick({ expired: 0, gmail: { inspected: 3, consumed: 0 }, slack: { inspected: 5 } })).toBeNull()
  expect(summarizeReplyTick({ slack: { inspected: 2, rejected: 1 } })).toEqual({ slack: { rejected: 1 } })
  expect(summarizeReplyTick({ gmail: { inspected: 2, rejected: { not_sent: 2, wrong_thread: 1 } }, slack: { rejected: {} } })).toEqual({ gmail: { rejected: 3 } })
})
