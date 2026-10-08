import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { ErrorBox } from '../lib/memory'

export const NATIVE_EMBEDDING_MODEL = 'embeddinggemma-2-native-q8-v1'
export function NativeEmbeddings() {
  const cache = useQueryClient(), key = ['memory-native-embeddings']
  const status = useQuery({ queryKey: key, queryFn: () => api.get<any>('/memory/embeddings/native'), refetchInterval: query => query.state.data?.state === 'downloading' ? 1000 : false })
  const action = useMutation({ mutationFn: (name: 'install' | 'cancel') => api.post('/memory/embeddings/native/' + name),
    onSuccess: result => { cache.setQueryData(key, result); void status.refetch() } })
  const state = status.data?.state, busy = state === 'downloading'
  return <div className="memory-callout"><div className="spread"><strong>EmbeddingGemma 2 integrado</strong><span className={`badge ${state === 'ready' ? 'badge-on' : 'badge-stale'}`}>{state === 'ready' ? 'Listo para usar' : busy ? 'Descargando y preparando' : 'Pendiente de descarga'}</span></div>
    <p>El Hub lo descarga y habilita automáticamente al iniciar o migrar una memoria anterior. Podés cancelar y reintentar. La búsqueda por significado se ejecuta en esta computadora, sin Ollama ni API key. Se descarga una vez el modelo de texto (aproximadamente 350 MB); después funciona sin conexión. Tus textos no se envían al descargarlo.</p>
    <p className="field-hint">Modelo de Google, licencia <a href="https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2" target="_blank" rel="noreferrer">Apache 2.0</a>. La descarga se obtiene de <a href="https://huggingface.co/onnx-community/embeddinggemma-2-ONNX" target="_blank" rel="noreferrer">Hugging Face</a>. Usa CPU y libera la memoria tras un minuto sin uso.</p>
    {busy && <div role="status"><p>{status.data?.file ? `Preparando ${status.data.file}` : 'Iniciando descarga…'}{typeof status.data?.percent === 'number' ? ` · ${Math.round(status.data.percent)}%` : ''}</p><progress aria-label="Descarga del archivo del modelo" max={100} value={status.data?.percent} /></div>}
    {state !== 'ready' && <button type="button" className="btn" disabled={action.isPending || status.isPending} onClick={() => action.mutate(busy ? 'cancel' : 'install')}>{busy ? 'Cancelar descarga' : state === 'error' ? 'Reintentar descarga' : 'Descargar modelo'}</button>}
    {state === 'ready' && <p className="field-hint">La configuración inicial lo activa y reconstruye el índice automáticamente. Si cambiaste el motor manualmente, guardá tu selección para usarlo.</p>}
    {status.data?.error && <p className="memory-inline-error" role="alert">{status.data.error}</p>}<ErrorBox error={status.error || action.error} />
  </div>
}
