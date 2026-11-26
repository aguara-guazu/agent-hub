import { expect, it, vi } from 'vitest'
import { runQuitFlow, type HubStopClient } from './hub-stop.js'

it('does not open a coordinated user quit when the installer has already signalled the process', async () => {
  const startQuit = vi.fn(() => {
    throw Error('unexpected coordinated stop')
  })
  await expect(
    runQuitFlow({
      activeUpdate: null,
      startQuit,
      forced: () => true,
      client: {} as HubStopClient,
      clearIntent: vi.fn(),
      onRun: vi.fn(),
      log: vi.fn(),
    }),
  ).resolves.toBe('proceed')
  expect(startQuit).not.toHaveBeenCalled()
})
