import { describe, expect, it } from 'vitest'

import {
  ISOLATION_ENV_VAR,
  RUNTIME_HOST_PROCESS,
  RUNTIME_REMOTE_HTTP,
  RUNTIME_TOOLHIVE,
  TRANSPORT_HTTP,
  TRANSPORT_STDIO,
  detectPlan,
  detectRuntimes,
  isolationAvailable,
  planRuntimes,
  runtimeFor,
  type ProbeResult,
  type Prober,
  type Which,
} from './detect.js'

const okProbe: Prober = (): ProbeResult => ({ ok: true, output: '1.2.3', error: '' })
const failProbe: Prober = (): ProbeResult => ({ ok: false, output: '', error: 'no responde' })
const whichAll: Which = () => '/usr/bin/x'
const whichNone: Which = () => null

describe('detectRuntimes', () => {
  it('con motor y ToolHive presentes y respondiendo, el aislamiento está disponible', () => {
    const availability = detectRuntimes({ which: whichAll, prober: okProbe, env: {} })
    expect(isolationAvailable(availability)).toBe(true)
    expect(availability.engines.some((e) => e.available)).toBe(true)
    expect(availability.toolhive.available).toBe(true)
  })

  it('sin binarios, no hay aislamiento y el motivo lo explica', () => {
    const availability = detectRuntimes({ which: whichNone, prober: okProbe, env: {} })
    expect(isolationAvailable(availability)).toBe(false)
  })

  it('con el motor instalado pero el demonio caído, no hay aislamiento', () => {
    const availability = detectRuntimes({ which: whichAll, prober: failProbe, env: {} })
    expect(isolationAvailable(availability)).toBe(false)
  })

  it('AGENTHUB_ISOLATION=off fuerza el camino degradado aunque haya motor', () => {
    const availability = detectRuntimes({ which: whichAll, prober: okProbe, env: { [ISOLATION_ENV_VAR]: 'off' } })
    expect(availability.forcedOff).toBe(true)
    expect(isolationAvailable(availability)).toBe(false)
  })
})

describe('planRuntimes', () => {
  it('elige ToolHive para stdio cuando hay aislamiento, y remote_http para http', () => {
    const plan = planRuntimes(detectRuntimes({ which: whichAll, prober: okProbe, env: {} }))
    expect(runtimeFor(plan, TRANSPORT_STDIO)).toBe(RUNTIME_TOOLHIVE)
    expect(runtimeFor(plan, TRANSPORT_HTTP)).toBe(RUNTIME_REMOTE_HTTP)
  })

  it('cae a host_process para stdio cuando no hay aislamiento', () => {
    const plan = planRuntimes(detectRuntimes({ which: whichNone, prober: okProbe, env: {} }))
    expect(runtimeFor(plan, TRANSPORT_STDIO)).toBe(RUNTIME_HOST_PROCESS)
    expect(plan.reasonByTransport[TRANSPORT_STDIO]).toContain('sin aislamiento')
  })

  it('detectPlan combina detección y plan', () => {
    const plan = detectPlan({ which: whichNone, prober: failProbe, env: {} })
    expect(runtimeFor(plan, TRANSPORT_STDIO)).toBe(RUNTIME_HOST_PROCESS)
  })
})
