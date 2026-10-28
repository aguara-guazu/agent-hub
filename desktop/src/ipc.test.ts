import { describe, expect, it } from 'vitest'
import { INVOKE_CHANNELS, IPC, RECEIVE_CHANNELS } from './ipc.js'

describe('contrato IPC', () => {
  it('los canales invoke son sólo los declarados', () => {
    expect([...INVOKE_CHANNELS].sort()).toEqual(
      [IPC.getCoreStatus, IPC.restartCore, IPC.getAutostart, IPC.setAutostart, IPC.getSession, IPC.syncNow, IPC.restartClient, IPC.openStoredPdf, IPC.attachNavigation].sort(),
    )
  })

  it('los canales main->renderer son el cambio de estado y la navegación', () => {
    expect([...RECEIVE_CHANNELS]).toEqual([IPC.coreStateChanged, IPC.navigate])
  })

  it('los nombres de canal están namespaced bajo agenthub:', () => {
    for (const channel of Object.values(IPC)) {
      expect(channel).toMatch(/^agenthub:/)
    }
  })
})
