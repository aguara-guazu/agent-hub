import { describe, expect, it } from 'vitest'
import { INVOKE_CHANNELS, IPC, RECEIVE_CHANNELS } from './ipc.js'

describe('contrato IPC', () => {
  it('los canales invoke son sólo los declarados', () => {
    expect([...INVOKE_CHANNELS].sort()).toEqual(
      [IPC.getCoreStatus, IPC.restartCore, IPC.getAutostart, IPC.setAutostart, IPC.getSession, IPC.syncNow, IPC.restartClient, IPC.openStoredPdf, IPC.attachNavigation, IPC.getLanguage, IPC.setLanguage, IPC.getVersionInfo, IPC.getAppVersion, IPC.getUpdateStatus, IPC.getAutoUpdate, IPC.setAutoUpdate,
        IPC.recordingStatus, IPC.recordingStart, IPC.recordingStop, IPC.recordingDismiss].sort(),
    )
  })

  it('los canales main->renderer son el cambio de estado, la navegación y la grabación', () => {
    expect([...RECEIVE_CHANNELS]).toEqual([IPC.coreStateChanged, IPC.navigate, IPC.recordingChanged])
  })

  it('los nombres de canal están namespaced bajo agenthub:', () => {
    for (const channel of Object.values(IPC)) {
      expect(channel).toMatch(/^agenthub:/)
    }
  })
})
