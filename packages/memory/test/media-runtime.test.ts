import { afterEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { MediaRuntime, mediaSettingsInput } from '../src/media-runtime.js'
const fake = vi.hoisted(() => ({ create: vi.fn(), recognize: vi.fn(), terminate: vi.fn(async () => {}) }))
vi.mock('tesseract.js', () => ({ OEM: { LSTM_ONLY: 1 }, createWorker: fake.create }))
afterEach(() => { vi.resetAllMocks() })
it('cancelar OCR rechaza una operación pendiente y libera el worker', async () => {
  const runtime = new MediaRuntime('/tmp/unused-media-cancel-fixture'), controller = new AbortController()
  vi.spyOn(runtime.ocr, 'installed').mockReturnValue(true)
  fake.create.mockResolvedValue({ recognize: fake.recognize, terminate: fake.terminate })
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  fake.recognize.mockImplementation(() => { started(); return new Promise(() => {}) })
  try {
    const data = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'white' } }).png().toBuffer()
    const task = runtime.process({ data, mime_type: 'image/png', filename: 'test.png' }, mediaSettingsInput.parse({ ocr: true }), controller.signal, async () => {})
    const rejected = expect(task).rejects.toThrow('cancelado')
    await ready; controller.abort(); await rejected; expect(fake.terminate).toHaveBeenCalled()
  } finally { await runtime.close() }
})
it('cancelar durante la inicialización también termina el worker si aparece después', async () => {
  const runtime = new MediaRuntime('/tmp/unused-media-cancel-fixture'), controller = new AbortController()
  vi.spyOn(runtime.ocr, 'installed').mockReturnValue(true)
  let start!: (value: any) => void
  fake.create.mockReturnValue(new Promise(resolve => { start = resolve }))
  try {
    const task = runtime.process({ data: Buffer.alloc(0), mime_type: 'image/png', filename: 'test.png' }, mediaSettingsInput.parse({ ocr: true }), controller.signal, async () => {})
    const rejected = expect(task).rejects.toThrow('cancelado')
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejected
    start({ terminate: fake.terminate }); await new Promise(resolve => setImmediate(resolve)); expect(fake.terminate).toHaveBeenCalledTimes(1)
  } finally { await runtime.close() }
})
