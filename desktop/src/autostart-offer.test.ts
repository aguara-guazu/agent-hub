import { describe, expect, it } from 'vitest'
import { AutostartOffer } from './autostart-offer.js'
import type { FeedEvent } from './schedule-feed.js'

const created: FeedEvent = { seq: 1, type: 'schedule.created', actor_kind: 'agent', schedule_id: 's1', run_id: null, title: 'Brief', project_id: null }

function harness(options: { enabled?: boolean; offered?: boolean; answer?: boolean } = {}) {
  const state = { enabled: options.enabled ?? false, offered: options.offered ?? false, asked: 0 }
  const offer = new AutostartOffer({
    isEnabled: () => state.enabled,
    setEnabled: value => { state.enabled = value },
    wasOffered: () => state.offered,
    markOffered: () => { state.offered = true },
    ask: async () => { state.asked += 1; return options.answer ?? true },
  })
  return { offer, state }
}

describe('AutostartOffer', () => {
  it('ofrece ante el primer schedule y activa el inicio si la persona acepta', async () => {
    const { offer, state } = harness()
    await offer.consider([created])
    expect(state).toEqual({ enabled: true, offered: true, asked: 1 })
  })

  it('si la persona declina queda marcada y no se vuelve a preguntar', async () => {
    const { offer, state } = harness({ answer: false })
    await offer.consider([created])
    await offer.consider([created])
    expect(state).toEqual({ enabled: false, offered: true, asked: 1 })
  })

  it('no pregunta si el inicio ya está activo ni si ya se ofreció', async () => {
    const enabled = harness({ enabled: true })
    await enabled.offer.consider([created])
    expect(enabled.state.asked).toBe(0)
    const offered = harness({ offered: true })
    await offered.offer.consider([created])
    expect(offered.state.asked).toBe(0)
  })

  it('ignora eventos que no crean un schedule', async () => {
    const { offer, state } = harness()
    await offer.consider([{ ...created, type: 'schedule.updated' }, { ...created, type: 'run.persisted' }])
    expect(state.asked).toBe(0)
  })

  it('no abre dos preguntas a la vez', async () => {
    let release: (value: boolean) => void = () => undefined
    let asked = 0
    const offer = new AutostartOffer({
      isEnabled: () => false, setEnabled: () => undefined, wasOffered: () => false, markOffered: () => undefined,
      ask: () => { asked += 1; return new Promise<boolean>(resolve => { release = resolve }) },
    })
    const first = offer.consider([created])
    await offer.consider([created])
    release(false)
    await first
    expect(asked).toBe(1)
  })
})
