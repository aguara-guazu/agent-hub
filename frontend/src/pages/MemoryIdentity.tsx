import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorBox, Pager, useMemory, useMemoryMutation, type MemoryEntity, type Page } from '../lib/memory'

const confidence: Record<string, string> = {high:'alta',medium:'media',low:'baja'}
const blockedLabels: Record<string, string> = {
  different_verified_emails: 'Tienen emails verificados distintos: puede ser la misma persona con dos cuentas, pero la unificación requiere confirmación humana.',
  shared_transcript: 'Hablan como personas distintas en la misma transcripción; no se unificó automáticamente.',
  auto_merge_disabled: 'La unificación automática está desactivada en Fuentes y ajustes.',
}
function reviewLabel(p: Record<string, any>, kind: 'identity' | 'duplicate') {
  const byAI = typeof p.reviewed_by === 'string' && p.reviewed_by.startsWith('ai')
  if (p.review_state === 'accepted') return byAI ? (kind === 'identity' ? 'Aplicado automáticamente por IA' : 'Unificado automáticamente por IA') : p.reviewed_by === 'system:merge' ? 'Resuelto al unificar' : kind === 'identity' ? 'Confirmado por una persona' : 'Unificado por una persona'
  if (p.review_state === 'rejected') return byAI ? 'La IA los considera distintos' : p.reviewed_by === 'system:merge' ? 'Resuelto al unificar' : 'Descartado'
  return kind === 'identity' ? 'Inferido por IA' : p.verdict === 'conflict' ? 'Conflicto de email' : 'Posible duplicado'
}

export function IdentityProposalCard({ proposal, onReview, busy = false }: { proposal: MemoryEntity; onReview: (id: string, decision: 'accepted' | 'rejected') => void; busy?: boolean }) {
  const p = proposal.data, known = p.candidate.origins?.some((o: any) => o.kind === 'known_person')
  return <article className="card memory-panel">
    <div className="spread"><strong>{p.speaker_name} → {p.candidate.email}</strong><span className="badge badge-stale">{reviewLabel(p, 'identity')}</span></div>
    <p>{p.reason}</p><p className="muted">Confianza declarada por el modelo: {confidence[p.confidence] ?? p.confidence} · {p.model}. Requiere contrastar la evidencia.</p>
    {p.review_state === 'pending' && known && <p className="muted">Confirmar unifica a {p.speaker_name} con la persona conocida que ya tiene este email: sus intervenciones pasan a ese perfil.</p>}
    {p.auto_apply_blocked && p.review_state === 'pending' && <p className="memory-inline-error">No se aplicó automáticamente: {p.auto_apply_blocked}</p>}
    <div className="memory-button-wrap"><Link className="btn btn-sm" to={`/memory/entities/${proposal.id}`}>Ver evidencia</Link><Link className="btn btn-sm" to={`/memory/entities/${p.speaker_id}`}>Ver hablante</Link>
      {p.candidate.origins?.map((o: any) => <Link className="btn btn-sm" key={`${o.kind}:${o.entity_id}`} to={`/memory/entities/${o.entity_id}`}>{o.kind === 'known_person' ? 'Persona conocida' : 'Invitación del calendario'}</Link>)}
      {p.review_state === 'pending' && <><button className="btn btn-primary btn-sm" disabled={busy || p.stale} onClick={() => onReview(proposal.id, 'accepted')}>{known ? 'Confirmar y unificar' : 'Confirmar email'}</button><button className="btn btn-sm" disabled={busy} onClick={() => onReview(proposal.id, 'rejected')}>Descartar</button></>}
    </div>{p.stale && <p className="memory-inline-error">La fuente cambió. Revisá el contenido actual antes de confirmar.</p>}
  </article>
}

export function IdentityProposals({ entityId, canInfer = false }: { entityId?: string; canInfer?: boolean }) {
  const [state, setState] = useState('pending'), [offset, setOffset] = useState(0)
  const proposals = useMemory<Page<MemoryEntity>>('list_identity_proposals', { ...(entityId ? { entity_id: entityId } : {}), state, limit: 10, offset })
  const infer = useMemoryMutation<{ queued: number }>('infer_identities'), review = useMemoryMutation('review_identity')
  useEffect(() => { const timer = setInterval(() => { void proposals.refetch() }, 5000); return () => clearInterval(timer) }, [proposals.refetch])
  return <section className="memory-section"><div className="spread"><h2>Vínculos sugeridos por IA</h2>{canInfer && <button className="btn" disabled={infer.isPending} onClick={() => infer.mutate(entityId ? { entity_id: entityId } : {})}>Inferir emails pendientes</button>}</div>
    <p className="muted">La IA compara hablantes con correos conocidos y participantes del calendario. Con confianza alta aplica el vínculo y unifica al hablante con la persona conocida; el resto queda acá para confirmar o descartar.</p>
    {infer.data && <p role="status">{infer.data.queued} fuentes encoladas. <Link to="/memory/processing">Ver procesamiento</Link></p>}
    <select className="input" aria-label="Estado de los vínculos inferidos" value={state} onChange={e => { setState(e.target.value); setOffset(0) }}><option value="pending">Pendientes</option><option value="accepted">Confirmados</option><option value="rejected">Descartados</option></select>
    <ErrorBox error={proposals.error ?? infer.error ?? review.error} />
    <div className="memory-processing-list">{proposals.data?.items.map(p => <IdentityProposalCard key={p.id} proposal={p} busy={review.isPending} onReview={(id, decision) => review.mutate({id,decision})} />)}</div>
    {proposals.data?.total === 0 && <p className="muted">No hay propuestas en este estado.</p>}{proposals.data && <Pager total={proposals.data.total} limit={10} offset={offset} setOffset={setOffset} />}
  </section>
}

export function DuplicateProposalCard({ proposal, onReview, busy = false }: { proposal: MemoryEntity; onReview: (id: string, decision: 'accepted' | 'rejected') => void; busy?: boolean }) {
  const p = proposal.data
  return <article className="card memory-panel">
    <div className="spread"><strong>{p.from_name} ≈ {p.into_name}</strong><span className="badge badge-stale">{reviewLabel(p, 'duplicate')}</span></div>
    <p>{p.reason}</p>
    <p className="muted">{p.basis === 'same_email' ? 'Detectado por email verificado compartido' : `Confianza declarada por el modelo: ${confidence[p.confidence] ?? p.confidence}${p.model ? ` · ${p.model}` : ''}`} · {p.from_email ?? 'sin email'} → {p.into_email ?? 'sin email'}{p.applied_rule === 'medium_corroborated' ? ' · Corroborado: nombre completo idéntico y etiqueta de documento sin email' : ''}</p>
    {p.blocked && p.review_state === 'pending' && <p className="memory-inline-error">{blockedLabels[p.blocked] ?? p.blocked}</p>}
    <div className="memory-button-wrap"><Link className="btn btn-sm" to={`/memory/entities/${proposal.id}`}>Ver evidencia</Link><Link className="btn btn-sm" to={`/memory/entities/${p.from_id}`}>Ver {p.from_name}</Link><Link className="btn btn-sm" to={`/memory/entities/${p.into_id}`}>Ver {p.into_name}</Link>
      {p.review_state === 'pending' && <><button className="btn btn-primary btn-sm" disabled={busy} onClick={() => onReview(proposal.id, 'accepted')}>Unificar en {p.into_name}</button><button className="btn btn-sm" disabled={busy} onClick={() => onReview(proposal.id, 'rejected')}>Son personas distintas</button></>}
    </div>
  </article>
}

export function DuplicateProposals({ entityId, canRun = false }: { entityId?: string; canRun?: boolean }) {
  const [state, setState] = useState('pending'), [offset, setOffset] = useState(0)
  const proposals = useMemory<Page<MemoryEntity>>('list_duplicate_proposals', { ...(entityId ? { entity_id: entityId } : {}), state, limit: 10, offset })
  const run = useMemoryMutation<{ id: string }>('dedupe_people'), review = useMemoryMutation('review_duplicate')
  useEffect(() => { const timer = setInterval(() => { void proposals.refetch() }, 5000); return () => clearInterval(timer) }, [proposals.refetch])
  return <section className="memory-section"><div className="spread"><h2>Personas duplicadas</h2>{canRun && <button className="btn" disabled={run.isPending} onClick={() => run.mutate({})}>Buscar duplicados</button>}</div>
    <p className="muted">Se unifican solos los perfiles con el mismo email verificado y los pares que la IA marca con confianza alta sin señales en contra. Lo demás queda acá: unificar traslada intervenciones e identidades al perfil elegido y conserva el historial.</p>
    {run.data && <p role="status">Búsqueda encolada. <Link to="/memory/processing">Ver procesamiento</Link></p>}
    <select className="input" aria-label="Estado de los duplicados" value={state} onChange={e => { setState(e.target.value); setOffset(0) }}><option value="pending">Pendientes</option><option value="accepted">Unificados</option><option value="rejected">Descartados</option></select>
    <ErrorBox error={proposals.error ?? run.error ?? review.error} />
    <div className="memory-processing-list">{proposals.data?.items.map(p => <DuplicateProposalCard key={p.id} proposal={p} busy={review.isPending} onReview={(id, decision) => review.mutate({id,decision})} />)}</div>
    {proposals.data?.total === 0 && <p className="muted">No hay duplicados en este estado.</p>}{proposals.data && <Pager total={proposals.data.total} limit={10} offset={offset} setOffset={setOffset} />}
  </section>
}
