import { describe, expect, it } from 'vitest'
import { graceDeadline, lastOccurrenceUpTo, localInstant, localIso, nextOccurrence } from '../src/schedule-time.js'

const BA = 'America/Argentina/Buenos_Aires', NY = 'America/New_York'
const at = (iso: string) => Date.parse(iso)
const iso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString()

describe('hora de pared', () => {
  it('convierte una hora local a instante UTC', () => {
    expect(iso(localInstant(2026, 10, 29, 8, 0, BA))).toBe('2026-10-29T11:00:00.000Z')
    expect(iso(localInstant(2026, 7, 1, 8, 0, NY))).toBe('2026-07-01T12:00:00.000Z')
  })
  it('una hora inexistente pasa al primer instante válido', () => {
    expect(iso(localInstant(2026, 3, 8, 2, 30, NY))).toBe('2026-03-08T07:00:00.000Z')
  })
  it('una hora repetida corre una sola vez, en su primera aparición', () => {
    expect(iso(localInstant(2026, 11, 1, 1, 30, NY))).toBe('2026-11-01T05:30:00.000Z')
  })
  it('expresa un instante con el desfase de la zona', () => {
    expect(localIso(at('2026-10-29T11:00:00Z'), BA)).toBe('2026-10-29T08:00:00-03:00')
    expect(localIso(at('2026-03-08T12:00:00Z'), NY)).toBe('2026-03-08T08:00:00-04:00')
  })
})

describe('próxima ocurrencia', () => {
  it('daily salta fines de semana según weekdays', () => {
    const rule = { type: 'daily' as const, time: '08:00', weekdays: [1, 2, 3, 4, 5] }
    expect(iso(nextOccurrence(rule, at('2026-10-30T12:00:00Z'), BA))).toBe('2026-11-02T11:00:00.000Z')
    expect(iso(nextOccurrence(rule, at('2026-10-29T10:00:00Z'), BA))).toBe('2026-10-29T11:00:00.000Z')
  })
  it('daily mantiene la hora de pared al cambiar el horario de verano', () => {
    const rule = { type: 'daily' as const, time: '08:00' }
    expect(iso(nextOccurrence(rule, at('2026-03-07T14:00:00Z'), NY))).toBe('2026-03-08T12:00:00.000Z')
  })
  it('daily nunca devuelve el mismo instante de referencia', () => {
    const rule = { type: 'daily' as const, time: '08:00' }
    expect(iso(nextOccurrence(rule, at('2026-10-29T11:00:00Z'), BA))).toBe('2026-10-30T11:00:00.000Z')
  })
  it('interval avanza desde el ancla sin acumular deriva', () => {
    const rule = { type: 'interval' as const, minutes: 60 }, anchor = at('2026-10-29T10:00:00Z')
    expect(iso(nextOccurrence(rule, at('2026-10-29T12:20:00Z'), BA, anchor))).toBe('2026-10-29T13:00:00.000Z')
    expect(iso(nextOccurrence(rule, at('2026-10-29T10:00:00Z'), BA))).toBe('2026-10-29T11:00:00.000Z')
  })
  it('once solo existe mientras esté en el futuro', () => {
    const rule = { type: 'once' as const, at: '2026-10-29T15:00:00Z' }
    expect(iso(nextOccurrence(rule, at('2026-10-29T14:00:00Z'), BA))).toBe('2026-10-29T15:00:00.000Z')
    expect(nextOccurrence(rule, at('2026-10-29T15:00:00Z'), BA)).toBeNull()
  })
})

describe('ocurrencia perdida', () => {
  it('daily coalesce las ocurrencias vencidas en la más reciente', () => {
    const rule = { type: 'daily' as const, time: '08:00' }
    expect(iso(lastOccurrenceUpTo(rule, at('2026-10-26T11:00:00Z'), at('2026-10-29T15:00:00Z'), BA))).toBe('2026-10-29T11:00:00.000Z')
  })
  it('daily con weekdays ignora los días no habilitados', () => {
    const rule = { type: 'daily' as const, time: '08:00', weekdays: [1, 2, 3, 4, 5] }
    expect(iso(lastOccurrenceUpTo(rule, at('2026-10-29T11:00:00Z'), at('2026-11-01T20:00:00Z'), BA))).toBe('2026-10-30T11:00:00.000Z')
  })
  it('interval toma la última ocurrencia múltiplo del paso', () => {
    const rule = { type: 'interval' as const, minutes: 60 }
    expect(iso(lastOccurrenceUpTo(rule, at('2026-10-29T10:00:00Z'), at('2026-10-29T13:30:00Z'), BA))).toBe('2026-10-29T13:00:00.000Z')
  })
  it('daily resuelve a la última ocurrencia aunque la ausencia supere cientos de días', () => {
    const rule = { type: 'daily' as const, time: '08:00' }
    expect(iso(lastOccurrenceUpTo(rule, at('2024-01-01T11:00:00Z'), at('2026-10-28T15:00:00Z'), BA))).toBe('2026-10-28T11:00:00.000Z')
    const weekdays = { type: 'daily' as const, time: '08:00', weekdays: [2] }
    expect(iso(lastOccurrenceUpTo(weekdays, at('2024-01-02T11:00:00Z'), at('2026-10-28T15:00:00Z'), BA))).toBe('2026-10-27T11:00:00.000Z')
  })
  it('daily no devuelve una ocurrencia anterior a la primera pendiente', () => {
    const rule = { type: 'daily' as const, time: '08:00' }
    expect(lastOccurrenceUpTo(rule, at('2026-10-29T11:00:00Z'), at('2026-10-29T10:00:00Z'), BA)).toBeNull()
    expect(lastOccurrenceUpTo(rule, at('2026-10-29T11:00:00Z'), at('2026-10-29T10:59:00Z'), BA)).toBeNull()
  })
  it('devuelve null cuando no se perdió nada', () => {
    const rule = { type: 'daily' as const, time: '08:00' }
    expect(lastOccurrenceUpTo(rule, at('2026-10-30T11:00:00Z'), at('2026-10-29T15:00:00Z'), BA)).toBeNull()
  })
})

describe('gracia', () => {
  it('minutes suma los minutos a la ocurrencia', () => {
    expect(iso(graceDeadline(at('2026-10-29T11:00:00Z'), { policy: 'minutes', minutes: 30 }, BA, null))).toBe('2026-10-29T11:30:00.000Z')
  })
  it('until_next vale hasta la ocurrencia siguiente', () => {
    expect(graceDeadline(at('2026-10-29T11:00:00Z'), { policy: 'until_next', minutes: 0 }, BA, at('2026-10-30T11:00:00Z'))).toBe(at('2026-10-30T11:00:00Z'))
  })
  it('until_local_time vale hasta la hora local del mismo día', () => {
    expect(iso(graceDeadline(at('2026-10-29T20:30:00Z'), { policy: 'until_local_time', minutes: 0, until: '22:00' }, BA, null))).toBe('2026-10-30T01:00:00.000Z')
  })
})
