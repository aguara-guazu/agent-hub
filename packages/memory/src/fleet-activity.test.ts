import { describe, expect, it } from 'vitest'
import { FleetActivityBuffer, unavailableActivity } from './fleet-activity.js'

describe('human fleet activity buffer', () => {
  it('redacts invitation/session credentials, including echoes and secret native answers', () => {
    const invitation = 'invitation-value-with-32-characters'
    const key = 'session-value-with-32-characters'
    const buffer = new FleetActivityBuffer(`Join invitation=${invitation}; session_key: "${key}"`)
    buffer.add('user', `Join invitation=${invitation}; session_key: "${key}"`)
    buffer.secret('private answer')
    buffer.add('tool', `Echo ${invitation} ${key} private answer`)
    const output = JSON.stringify(buffer.read('busy'))
    expect(output).not.toContain(invitation)
    expect(output).not.toContain(key)
    expect(output).not.toContain('private answer')
    expect(output).toContain('[redacted]')
  })
  it('redacts known credentials even when native output splits them across deltas', () => {
    const buffer = new FleetActivityBuffer('invitation=synthetic-secret-token-1234567890')
    buffer.stream('echo', 'assistant', 'Echo synthetic-secret-')
    buffer.stream('echo', 'assistant', 'token-1234567890 done')
    buffer.stream('echo', 'assistant', 'Echo synthetic-secret-token-1234567890 done', true)
    expect(buffer.read('idle').items.map(item => item.text).join('')).toBe('Echo [redacted] done')
  })
  it('deduplicates native deltas/finals and returns immutable cursor snapshots', () => {
    const buffer = new FleetActivityBuffer('task')
    buffer.stream('a', 'assistant', 'Hello ')
    buffer.stream('a', 'assistant', 'world')
    buffer.stream('a', 'assistant', 'Hello world!', true)
    buffer.stream('a', 'assistant', 'Hello world!', true)
    expect(buffer.read('idle').items.map(item => item.text).join('')).toBe('Hello world!')
    const page = buffer.read('idle', 2)
    expect(page.items.map(item => item.text)).toEqual(['!'])
    page.items[0]!.text = 'mutated'
    expect(buffer.read('idle', 2).items[0]!.text).toBe('!')
    expect(page.next_cursor).toBe(3)
  })
  it('bounds entries and bytes, reports lost prefixes, resets generation', () => {
    const buffer = new FleetActivityBuffer('task')
    for (let i = 0; i < 600; i++) buffer.add('tool', 'x'.repeat(10_000))
    const activity = buffer.read('stopped')
    expect(activity.items.length).toBeLessThanOrEqual(500)
    expect(Buffer.byteLength(JSON.stringify(activity.items))).toBeLessThan(262_144)
    expect(activity.next_cursor).toBe(600)
    expect(activity.truncated).toBe(true)
    expect(buffer.read('stopped', 600).items).toEqual([])
    expect(new FleetActivityBuffer('task').generation).not.toBe(activity.generation)
    expect(unavailableActivity()).toEqual({ supported: false, reason: 'native_transport_unavailable', items: [], next_cursor: 0 })
  })
})
