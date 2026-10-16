import { afterEach, expect, it, vi } from 'vitest'
import { SilentUpdates, hiddenUpdateLaunch, updateRelaunchArgs } from './silent-updates.js'

const update = { state: 'downloaded' as const, version: '0.9.0', path: '/test/installer', strategy: 'nsis' as const }
afterEach(() => vi.useRealTimers())
it('instala apenas termina la descarga, sin depender de una ventana ni aprobación', async () => {
  const check = vi.fn().mockResolvedValue(update), apply = vi.fn().mockResolvedValue(true), log = vi.fn()
  const loop = new SilentUpdates({ check, apply, log })
  await Promise.all([loop.run(), loop.run()])
  expect(check).toHaveBeenCalledTimes(1); expect(apply).toHaveBeenCalledExactlyOnceWith(update); expect(log).not.toHaveBeenCalled()
  loop.stop()
})
it('espera puentes vivos y reintenta sin volver a descargar ni pedir intervención', async () => {
  vi.useFakeTimers()
  const check = vi.fn().mockResolvedValue(update), apply = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
  const loop = new SilentUpdates({ check, apply, log: vi.fn() })
  await loop.run(); expect(apply).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(check).toHaveBeenCalledTimes(1); expect(apply).toHaveBeenCalledTimes(2)
  loop.stop()
})
it('fallos se registran y reintentan con backoff; detener cancela futuras instalaciones', async () => {
  vi.useFakeTimers()
  const check = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(update), apply = vi.fn().mockResolvedValue(true), log = vi.fn()
  const loop = new SilentUpdates({ check, apply, log })
  await loop.run(); expect(log).toHaveBeenCalledWith('offline'); expect(apply).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(60_000); expect(apply).toHaveBeenCalledTimes(1)
  loop.stop(); await vi.advanceTimersByTimeAsync(86_400_000); expect(check).toHaveBeenCalledTimes(2)
})
it('salir durante la descarga impide aplicar el resultado tardío', async () => {
  let finish!: (value: typeof update) => void
  const apply = vi.fn(), loop = new SilentUpdates({ check: () => new Promise(resolve => { finish = resolve }), apply, log: vi.fn() })
  const running = loop.run(); loop.stop(); finish(update); await running
  expect(apply).not.toHaveBeenCalled()
})
it('todo relanzamiento de actualización queda oculto, sin acumular argumentos', () => {
  expect(hiddenUpdateLaunch(['--updated'])).toBe(true)
  expect(hiddenUpdateLaunch([])).toBe(false)
  expect(updateRelaunchArgs(['--hidden', '--updated', '--test'])).toEqual(['--test', '--hidden', '--updated'])
})
