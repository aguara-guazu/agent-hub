import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { ErrorBox, Field } from '../lib/memory'

interface Status { installed: boolean; models: { id: string; name: string }[]; detail?: string }
export function OpenCodeExtraction({ model, onModel }: { model: string; onModel: (model: string) => void }) {
  const status = useQuery({ queryKey: ['memory-opencode'], queryFn: () => api.get<Status>('/memory/opencode'), staleTime: 30_000, retry: false })
  const test = useMutation({ mutationFn: (model: string) => api.post<{ ok: boolean; model: string }>('/memory/opencode/test', { model }) })
  return <div className="memory-callout">
    <p>Agent Hub usa tu conexión de OpenCode para procesar cada transcripción nueva automáticamente, en segundo plano. No necesitás abrir OpenCode ni pedirle que procese la reunión.</p>
    <Field label="Modelo de OpenCode"><select required value={model} onChange={e => onModel(e.target.value)} disabled={status.isPending}>
      <option value="">{status.isPending ? 'Buscando modelos…' : 'Elegí un modelo'}</option>
      {model && !status.data?.models.some(m => m.id === model) && <option value={model}>{model} · Verificar disponibilidad</option>}
      {status.data?.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select></Field>
    {status.data?.detail && <p role="status">{status.data.detail}</p>}
    <ErrorBox error={status.error} />
    <div className="memory-button-wrap"><button className="btn" type="button" disabled={status.isFetching} onClick={() => void status.refetch()}>Actualizar modelos</button>
      <button className="btn" type="button" disabled={!model || test.isPending} onClick={() => test.mutate(model)}>{test.isPending ? 'Probando extracción…' : 'Probar modelo'}</button></div>
    <p className="field-hint">La prueba usa un texto de ejemplo. Al guardar también verificamos que el modelo pueda completar una extracción.</p>
    {test.variables === model && <><ErrorBox error={test.error} />{test.isSuccess && <p role="status">Modelo verificado: respondió correctamente en segundo plano.</p>}</>}
  </div>
}
