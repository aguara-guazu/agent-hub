import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { ErrorBox, Field } from '../lib/memory'

interface Status { installed: boolean; models: { id: string; name: string }[]; detail?: string }
export const EXTRACTION_CLI_LABELS: Record<string, string> = { opencode: 'OpenCode', claude_code: 'Claude Code', codex_cli: 'Codex', kiro: 'Kiro CLI' }
export function CliExtraction({ provider = 'opencode', model, onModel }: { provider?: string; model: string; onModel: (model: string) => void }) {
  const label = EXTRACTION_CLI_LABELS[provider], path = provider === 'opencode' ? '/memory/opencode' : `/memory/extraction-cli/${provider}`
  const status = useQuery({ queryKey: ['memory-extraction-cli', provider], queryFn: () => api.get<Status>(path), staleTime: 30_000, retry: false })
  const test = useMutation({ mutationFn: (model: string) => api.post<{ ok: boolean; model: string; resolved_model?: string }>(`${path}/test`, { model }) })
  return <div className="memory-callout">
    <p>Agent Hub usa tu conexión de {label} para procesar cada transcripción nueva automáticamente, en segundo plano. No necesitás abrir {label} ni pedirle que procese la reunión.</p>
    <Field label={`Modelo de ${label}`}><select required value={model} onChange={e => onModel(e.target.value)} disabled={status.isPending}>
      <option value="">{status.isPending ? 'Buscando modelos…' : 'Elegí un modelo'}</option>
      {model && !status.data?.models.some(m => m.id === model) && <option value={model}>{model} · Verificar disponibilidad</option>}
      {status.data?.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select></Field>
    {provider !== 'opencode' && <Field label="Modelo por nombre (opcional)"><input value={model} onChange={e => onModel(e.target.value)} placeholder="También podés escribir un ID admitido por tu CLI" /></Field>}
    {provider !== 'opencode' && <p className="field-hint">Usa la autenticación de la CLI instalada y consume los límites de esa cuenta. No necesitás copiar sus credenciales a Agent Hub.</p>}
    {provider === 'kiro' && <p className="field-hint">La autenticación admitida depende de la versión y cuenta de Kiro. Si pide una API key en modo no interactivo, configurala en Kiro y volvé a probar.</p>}
    {status.data?.detail && <p role="status">{status.data.detail}</p>}
    <ErrorBox error={status.error} />
    <div className="memory-button-wrap"><button className="btn" type="button" disabled={status.isFetching} onClick={() => void status.refetch()}>Actualizar modelos</button>
      <button className="btn" type="button" disabled={!model || status.data?.installed === false || test.isPending} onClick={() => test.mutate(model)}>{test.isPending ? 'Probando extracción…' : 'Probar modelo'}</button></div>
    <p className="field-hint">La prueba usa un texto de ejemplo. Al guardar también verificamos que el modelo pueda completar una extracción.</p>
    {test.variables === model && <><ErrorBox error={test.error} />{test.isSuccess && <p role="status">Modelo verificado: respondió correctamente en segundo plano.{test.data?.resolved_model && ` Modelo utilizado: ${test.data.resolved_model}.`}</p>}</>}
  </div>
}
