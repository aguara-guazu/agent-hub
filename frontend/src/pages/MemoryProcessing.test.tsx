import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { MemoryJobCard } from './MemoryProcessing'

it('muestra la fuente, el avance real, tokens y controles del trabajo de DeepSeek', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div'), root = createRoot(container), cancel = vi.fn()
  const job = { id: 'job', entity_id: 'meeting', source_title: 'Reunión con el cliente', kind: 'process', state: 'running', attempts: 1, max_attempts: 5,
    payload: { version_id: 'version' }, created_at: '2026-09-13T10:00:00Z', progress: { provider: 'deepseek', model: 'deepseek-flash', stage: 'extraction',
      total_batches: 5, batch: 2, current_batch: 3, total_fragments: 180, processed_fragments: 80, input_tokens: 3000, output_tokens: 500, extracted: 8 } }
  try {
    await act(async () => { root.render(<MemoryRouter><MemoryJobCard job={job} onRetry={vi.fn()} onCancel={cancel} /></MemoryRouter>) })
    expect(container.textContent).toContain('deepseek-flash')
    expect(container.textContent).toContain('Lotes completados: 2/5')
    expect(container.textContent).toContain('procesando lote 3')
    expect(container.textContent).toContain('8 propuestas')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/memory/entities/meeting?version=version')
    expect(container.querySelector('progress')?.value).toBe(2)
    expect(container.querySelector('progress')?.max).toBe(5)
    act(() => { container.querySelector('button')?.click() })
    expect(cancel).toHaveBeenCalledWith('job')
    await act(async () => { root.render(<MemoryRouter><MemoryJobCard job={{ ...job, state: 'completed', progress: { ...job.progress, stage: 'complete' } }} onRetry={vi.fn()} onCancel={cancel} /></MemoryRouter>) })
    expect(container.textContent).toContain('Completado')
    expect(container.querySelector('progress')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
  } finally { act(() => root.unmount()) }
})
