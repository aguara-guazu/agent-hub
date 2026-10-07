import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { ErrorBox, Field } from '../lib/memory'

interface Status { installed: boolean; models: { id: string; name: string; reasoning_efforts?: string[] }[]; detail?: string }
const effortLabels: Record<string, string> = { none: 'Sin razonamiento', minimal: 'Mínimo', low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo', ultra: 'Ultra' }
export const EXTRACTION_CLI_LABELS: Record<string, string> = { opencode: 'OpenCode', claude_code: 'Claude Code', codex_cli: 'Codex', kiro: 'Kiro CLI' }
export function CliExtraction({ provider = 'opencode', model, onModel, effort = '', onEffort }: { provider?: string; model: string; onModel: (model: string) => void; effort?: string; onEffort: (effort: string) => void }) {
  const label = EXTRACTION_CLI_LABELS[provider], path = provider === 'opencode' ? '/memory/opencode' : `/memory/extraction-cli/${provider}`
  const status = useQuery({ queryKey: ['memory-extraction-cli', provider], queryFn: () => api.get<Status>(path), staleTime: 30_000, retry: false })
  const efforts = status.data?.models.find(m => m.id === model)?.reasoning_efforts ?? []
  const test = useMutation({ mutationFn: (selection: { model: string; reasoning_effort?: string }) => api.post<{ ok: boolean; model: string; resolved_model?: string }>(`${path}/test`, selection) })
  return <div className="memory-callout">
    <p>Agent Hub usa tu conexión de {label} para procesar cada transcripción nueva automáticamente, en segundo plano. No necesitás abrir {label} ni pedirle que procese la reunión.</p>
    <Field label={`Modelo de ${label}`}><select required value={model} onChange={e => onModel(e.target.value)} disabled={status.isPending}>
      <option value="">{status.isPending ? 'Buscando modelos…' : 'Elegí un modelo'}</option>
      {model && !status.data?.models.some(m => m.id === model) && <option value={model}>{model} · Verificar disponibilidad</option>}
      {status.data?.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select></Field>
    {provider !== 'opencode' && <Field label="Modelo por nombre (opcional)"><input value={model} onChange={e => onModel(e.target.value)} placeholder="También podés escribir un ID admitido por tu CLI" /></Field>}
    <Field label={provider === 'opencode' ? 'Esfuerzo de razonamiento / variante' : 'Esfuerzo de razonamiento'}><select aria-label="Esfuerzo de razonamiento" value={effort} onChange={e => onEffort(e.target.value)} disabled={!model || status.isPending}>
      <option value="">Predeterminado de la CLI</option>
      {effort && !efforts.includes(effort) && <option value={effort}>{effort} · Verificar disponibilidad</option>}
      {efforts.map(value => <option key={value} value={value}>{effortLabels[value] ? `${effortLabels[value]} (${value})` : value}</option>)}
    </select></Field>
    <p className="field-hint">Más esfuerzo puede consumir más tiempo y cuota. La selección se aplica a las próximas tareas en segundo plano.{model && !status.isPending && !efforts.length && ' No hay niveles confirmados para este modelo; podés usar el valor predeterminado.'}</p>
    {provider !== 'opencode' && <p className="field-hint">Usa la autenticación de la CLI instalada y consume los límites de esa cuenta. No necesitás copiar sus credenciales a Agent Hub.</p>}
    {provider === 'kiro' && <p className="field-hint">Kiro exige su propia API key para automatización. Configurá KIRO_API_KEY en el entorno de Agent Hub; el inicio de sesión interactivo por sí solo no habilita este procesamiento.</p>}
    {status.data?.detail && <p role="status">{status.data.detail}</p>}
    <ErrorBox error={status.error} />
    <div className="memory-button-wrap"><button className="btn" type="button" disabled={status.isFetching} onClick={() => void status.refetch()}>Actualizar modelos</button>
      <button className="btn" type="button" disabled={!model || status.data?.installed === false || test.isPending} onClick={() => test.mutate({ model, ...(effort ? { reasoning_effort: effort } : {}) })}>{test.isPending ? 'Probando extracción…' : 'Probar modelo'}</button></div>
    <p className="field-hint">La prueba usa un texto de ejemplo. Al guardar también verificamos que el modelo pueda completar una extracción.</p>
    {test.variables?.model === model && (test.variables.reasoning_effort ?? '') === effort && <><ErrorBox error={test.error} />{test.isSuccess && <p role="status">Modelo verificado: respondió correctamente en segundo plano.{test.data?.resolved_model && ` Modelo utilizado: ${test.data.resolved_model}.`}</p>}</>}
  </div>
}
