import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { DuplicateProposalCard, IdentityProposalCard } from './MemoryIdentity'
import type { MemoryEntity } from '../lib/memory'

it('presenta la inferencia y su evidencia sin llamarla confirmada, y bloquea confirmar evidencia obsoleta', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div'), root = createRoot(container), review = vi.fn()
  const proposal: MemoryEntity = { id: 'proposal', kind: 'fact', title: 'Anita → ana@example.com', created_at: '2026-09-13T20:00:00Z', updated_at: '2026-09-13T20:00:00Z', data: { speaker_id: 'speaker', speaker_name: 'Anita', candidate: { email: 'ana@example.com', origins: [{kind:'calendar_invitee',entity_id:'calendar'}] },
    reason: 'Se presenta con su nombre completo.', confidence: 'high', model: 'deepseek-flash', review_state: 'pending' } }
  try {
    await act(async () => { root.render(<MemoryRouter><IdentityProposalCard proposal={proposal} onReview={review} /></MemoryRouter>) })
    expect(container.textContent).toContain('Inferido por IA')
    expect(container.textContent).toContain('Confianza declarada por el modelo: alta')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/memory/entities/proposal')
    await act(async () => { container.querySelector('button')!.click() })
    expect(review).toHaveBeenCalledWith('proposal', 'accepted')
    await act(async () => { root.render(<MemoryRouter><IdentityProposalCard proposal={{ ...proposal, data: {...proposal.data, stale: true} }} onReview={review} /></MemoryRouter>) })
    expect(container.querySelector('button')!.disabled).toBe(true)
    expect(container.textContent).toContain('La fuente cambió')
  } finally { act(() => root.unmount()) }
})

it('distingue una unificación automática de una pendiente bloqueada y ofrece unificar o separar', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div'), root = createRoot(container), review = vi.fn()
  const proposal: MemoryEntity = { id: 'dup', kind: 'fact', title: 'Gastón ≈ Gaston Zarate', created_at: '2026-09-13T20:00:00Z', updated_at: '2026-09-13T20:00:00Z', data: { category: 'person_duplicate', from_id: 'label', into_id: 'meet', from_name: 'Gastón', into_name: 'Gaston Zarate',
    from_email: null, into_email: 'gaston@example.com', basis: 'ai', verdict: 'same', confidence: 'high', model: 'deepseek-flash', reason: 'Habla en el documento vinculado a la reunión donde participó Gaston Zarate.', review_state: 'pending', blocked: 'shared_transcript' } }
  try {
    await act(async () => { root.render(<MemoryRouter><DuplicateProposalCard proposal={proposal} onReview={review} /></MemoryRouter>) })
    expect(container.textContent).toContain('Posible duplicado')
    expect(container.textContent).toContain('misma transcripción')
    await act(async () => { container.querySelector('button')!.click() })
    expect(review).toHaveBeenCalledWith('dup', 'accepted')
    await act(async () => { root.render(<MemoryRouter><DuplicateProposalCard proposal={{ ...proposal, data: { ...proposal.data, review_state: 'accepted', reviewed_by: 'ai:auto', applied: 'merged', blocked: undefined } }} onReview={review} /></MemoryRouter>) })
    expect(container.textContent).toContain('Unificado automáticamente por IA')
    expect(container.querySelector('button')).toBeNull()
  } finally { act(() => root.unmount()) }
})
