import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { ErrorBox, Field } from '../lib/memory'

interface Status { installed: boolean; models: { id: string; name: string }[]; detail?: string }
export function OpenCodeExtraction({ model, onModel }: { model: string; onModel: (model: string) => void }) {
  const status = useQuery({ queryKey: ['memory-opencode'], queryFn: () => api.get<Status>('/memory/opencode'), staleTime: 30_000, retry: false })
  return <div className="memory-callout">
    <p>Agent Hub usa tu conexión de OpenCode para procesar cada transcripción nueva automáticamente, en segundo plano. No necesitás abrir OpenCode ni pedirle que procese la reunión.</p>
    <Field label="Modelo de OpenCode"><select required value={model} onChange={e => onModel(e.target.value)} disabled={status.isPending}>
      <option value="">{status.isPending ? 'Buscando modelos…' : 'Elegí un modelo'}</option>
      {model && !status.data?.models.some(m => m.id === model) && <option value={model}>{model} · Verificar disponibilidad</option>}
      {status.data?.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select></Field>
    {status.data?.detail && <p role="status">{status.data.detail}</p>}
    <ErrorBox error={status.error} />
    <button className="btn" type="button" disabled={status.isFetching} onClick={() => void status.refetch()}>Actualizar modelos</button>
  </div>
}
