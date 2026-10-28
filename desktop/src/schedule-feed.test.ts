import { describe, expect, it } from 'vitest'
import { deliveryNotice, FeedPoller, ScheduleNoticeBatcher, type ActiveRun, type FeedEvent, type FeedResponse, type Notice } from './schedule-feed.js'

function event(seq: number, overrides: Partial<FeedEvent> = {}): FeedEvent {
  return { seq, type: 'schedule.created', actor_kind: 'agent', schedule_id: `s${seq}`, run_id: null, title: `Brief ${seq}`, project_id: 'p1', ...overrides }
}

describe('FeedPoller', () => {
  function harness(responses: FeedResponse[]) {
    const calls: (number | null)[] = []
    const seen: FeedEvent[][] = []
    const active: ActiveRun[][] = []
    const queue = [...responses]
    const poller = new FeedPoller({
      fetchFeed: async after => { calls.push(after); return queue.shift()! },
      onEvents: events => seen.push(events),
      onActiveRuns: runs => active.push(runs),
    })
    return { poller, calls, seen, active }
  }

  it('el primer ciclo fija el cursor sin entregar historial', async () => {
    const { poller, calls, seen } = harness([{ events: [event(1), event(2)], cursor: 2 }])
    await poller.poll()
    expect(calls).toEqual([null])
    expect(seen).toEqual([])
  })

  it('los ciclos siguientes piden desde el cursor y entregan sólo lo nuevo', async () => {
    const { poller, calls, seen } = harness([
      { events: [], cursor: 5 },
      { events: [event(6), event(7)], cursor: 7 },
      { events: [event(7)], cursor: 7 },
    ])
    await poller.poll()
    await poller.poll()
    await poller.poll()
    expect(calls).toEqual([null, 5, 7])
    expect(seen.map(batch => batch.map(e => e.seq))).toEqual([[6, 7]])
  })

  it('informa los runs activos en cada ciclo, también vacíos', async () => {
    const run = { run_id: 'r1', phase: 'collect', deadline_at: '2026-10-28T12:00:00Z' }
    const { poller, active } = harness([{ events: [], cursor: 1, active_runs: [run] }, { events: [], cursor: 1 }])
    await poller.poll()
    await poller.poll()
    expect(active).toEqual([[run], []])
  })

  it('un error de red no mueve el cursor', async () => {
    let fail = true
    const calls: (number | null)[] = []
    const poller = new FeedPoller({
      fetchFeed: async after => { calls.push(after); if (fail) { fail = false; throw new Error('core caído') } return { events: [], cursor: 3 } },
      onEvents: () => undefined,
      onActiveRuns: () => undefined,
    })
    await expect(poller.poll()).rejects.toThrow('core caído')
    await poller.poll()
    expect(calls).toEqual([null, null])
  })
})

describe('deliveryNotice', () => {
  it('avisa un brief o un cierre persistido y abre su entrega', () => {
    expect(deliveryNotice(event(1, { type: 'run.persisted', run_id: 'r1', artifact_kind: 'brief', title: 'Brief · martes 28/10' }))).toEqual({ title: 'Brief listo', body: 'Brief · martes 28/10', route: '/deliveries/r1' })
    expect(deliveryNotice(event(2, { type: 'run.persisted', run_id: 'r2', artifact_kind: 'close', title: 'Cierre' }))?.title).toBe('Cierre listo')
  })

  it('ignora otros eventos, otros tipos de artefacto y runs sin id', () => {
    expect(deliveryNotice(event(3, { type: 'run.started', run_id: 'r3' }))).toBeNull()
    expect(deliveryNotice(event(4, { type: 'run.persisted', run_id: 'r4', artifact_kind: 'status' }))).toBeNull()
    expect(deliveryNotice(event(5, { type: 'run.persisted', run_id: null, artifact_kind: 'brief' }))).toBeNull()
  })
})

describe('ScheduleNoticeBatcher', () => {
  function harness() {
    const emitted: Notice[] = []
    const timers = new Map<number, { callback: () => void; ms: number }>()
    let next = 1
    const batcher = new ScheduleNoticeBatcher({
      setTimer: (callback, ms) => { const id = next++; timers.set(id, { callback, ms }); return id },
      clearTimer: handle => { timers.delete(handle as number) },
      emit: notice => emitted.push(notice),
      windowMs: 60_000,
    })
    const fire = (): void => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback() } }
    return { batcher, emitted, timers, fire }
  }

  it('un cambio de agente produce un aviso específico con foco en el schedule', () => {
    const { batcher, emitted, timers, fire } = harness()
    batcher.add([event(1, { title: 'Brief · Proyecto X' })])
    expect([...timers.values()][0]!.ms).toBe(60_000)
    fire()
    expect(emitted).toEqual([{ title: 'Tu agente programó: Brief · Proyecto X', body: 'Haz clic para verlo o cancelarlo.', route: '/schedules?focus=s1' }])
  })

  it('varios cambios dentro de la ventana salen como un solo aviso sin foco', () => {
    const { batcher, emitted, timers, fire } = harness()
    batcher.add([event(1)])
    batcher.add([event(2)])
    expect(timers.size).toBe(1)
    fire()
    expect(emitted).toEqual([{ title: 'Tu agente programó 2 automatizaciones', body: 'Haz clic para verlas.', route: '/schedules' }])
  })

  it('distingue cambio de horario, cancelación y lotes mixtos', () => {
    const one = harness()
    one.batcher.add([event(1, { type: 'schedule.updated', title: 'Cierre' })])
    one.fire()
    expect(one.emitted[0]!.title).toBe('Tu agente cambió el horario: Cierre')
    const cancelled = harness()
    cancelled.batcher.add([event(1, { type: 'schedule.cancelled', title: 'Cierre' })])
    cancelled.fire()
    expect(cancelled.emitted[0]!.title).toBe('Tu agente canceló: Cierre')
    const mixed = harness()
    mixed.batcher.add([event(1), event(2, { type: 'schedule.cancelled' })])
    mixed.fire()
    expect(mixed.emitted[0]!.title).toBe('Tu agente cambió 2 automatizaciones')
  })

  it('no avisa cambios humanos ni del sistema ni eventos que no son de schedules', () => {
    const { batcher, emitted, timers } = harness()
    batcher.add([event(1, { actor_kind: 'human' }), event(2, { actor_kind: 'system' }), event(3, { type: 'schedule.paused' }), event(4, { type: 'run.persisted' })])
    expect(timers.size).toBe(0)
    expect(emitted).toEqual([])
  })

  it('tras emitir, un cambio posterior abre una ventana nueva; dispose descarta lo pendiente', () => {
    const { batcher, emitted, timers, fire } = harness()
    batcher.add([event(1)])
    fire()
    batcher.add([event(2)])
    expect(timers.size).toBe(1)
    batcher.dispose()
    expect(timers.size).toBe(0)
    fire()
    expect(emitted).toHaveLength(1)
  })
})
