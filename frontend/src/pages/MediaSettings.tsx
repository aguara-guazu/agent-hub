import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { ErrorBox, Field, useMemoryMutation } from '../lib/memory'

const modules = [
  { key: 'ocr', title: 'OCR de imágenes y capturas', size: 'Datos de español e inglés · unos 5 MB', text: 'Reconoce texto y su ubicación. Motor Tesseract local.' },
  { key: 'decoder', title: 'Lectura de audio y video', size: 'Herramientas locales · entre 90 y 166 MB', text: 'FFmpeg y FFprobe se descargan desde ffmpeg-static y se verifican antes de ejecutarse. El Hub los administra; no hace falta instalarlos por separado.' },
  { key: 'speech', title: 'Transcripción con Whisper', size: 'Modelo base multilingüe · unos 80 MB', text: 'Genera una transcripción revisable con timestamps. Requiere el módulo de lectura de audio y video.' },
  { key: 'vision', title: 'Búsqueda de imágenes y video', size: 'Encoder visual de Gemma 2 · unos 195 MB adicionales', text: 'Busca por el contenido visual, aunque no tenga texto. Los videos se analizan por secuencias de fotogramas.' },
  { key: 'audio', title: 'Búsqueda por contenido sonoro', size: 'Encoder de audio de Gemma 2 · unos 340 MB adicionales', text: 'Busca sonidos y contenido de audio por significado. Requiere el módulo de lectura de audio y video.' },
]
export function MediaSettings() {
  const cache = useQueryClient(), key = ['memory-media']
  const query = useQuery({ queryKey: key, queryFn: () => api.get<any>('/memory/media'), refetchInterval: q => Object.values(q.state.data?.modules ?? {}).some((m: any) => m.state === 'downloading') ? 1000 : false })
  const [draft, setDraft] = useState<any>(null), settings = draft ?? query.data?.settings
  const save = useMutation({ mutationFn: (value: any) => api.put<any>('/memory/media', value), onSuccess: (result, submitted) => {
    cache.setQueryData(key, result); setDraft((current: any) => JSON.stringify(current) === JSON.stringify(submitted) ? null : current)
  } })
  const process = useMemoryMutation('process_files')
  const changed = settings && JSON.stringify(settings) !== JSON.stringify(query.data?.settings)
  return <section className="card memory-panel"><h2>Imágenes, audio, video y PDF</h2>
    <p>Procesá el contenido en esta computadora. Los módulos se descargan una vez; después funcionan sin conexión y no envían archivos a servicios externos.</p>
    <div className="memory-media-modules">{modules.map(module => <MediaModule key={module.key} module={module} status={query.data?.modules?.[module.key]} onChange={() => void query.refetch()} />)}</div>
    <p className="field-hint">Los encoders visual y sonoro comparten el modelo de texto (unos 350 MB si todavía no está descargado). <a href="https://github.com/aguara-guazu/agent-hub/blob/main/docs/media-processing.md" target="_blank" rel="noreferrer">Guía de instalación, formatos y licencias</a>.</p>
    <div className="memory-callout"><strong>Lector PDF incluido</strong><p>Extrae texto por página sin descargas adicionales. El encoder visual incluye gráficos e imágenes; OCR reconoce las páginas escaneadas sin texto suficiente. Conserva el PDF original y genera las vistas de páginas sólo cuando se necesitan.</p></div>
    {settings && <form className="memory-form" onSubmit={e => { e.preventDefault(); if (changed) save.mutate(settings) }}>
      {([['pdf','Procesar PDF por páginas'],['ocr','Reconocer texto (español e inglés)'],['transcription','Transcribir audio'],['vision','Indexar imágenes y video por significado'],['audio','Indexar contenido sonoro'],['automatic','Procesar automáticamente los archivos guardados']] as const).map(([name,label]) => <label className="check" key={name}><input type="checkbox" checked={settings[name]} onChange={e => setDraft({ ...settings, [name]: e.target.checked })} />{label}</label>)}
      <Field label="Idioma de la transcripción"><select value={settings.language} onChange={e => setDraft({ ...settings, language: e.target.value })}>{Object.entries({ es: 'Español', en: 'Inglés', pt: 'Portugués', fr: 'Francés', de: 'Alemán', it: 'Italiano', ja: 'Japonés', zh: 'Chino', ko: 'Coreano', ru: 'Ruso', ar: 'Árabe', hi: 'Hindi' }).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <p className="field-hint">Hasta 25 MB por archivo, 30 minutos de audio/video o 200 páginas de PDF. Se toma un fotograma cada 5 segundos para video. OCR y transcripciones pueden contener errores: se conserva el original y cada análisis crea una versión con sus citas.</p>
      <p className="field-hint">Para buscar embeddings audiovisuales, elegí EmbeddingGemma 2 integrado como motor de búsqueda. Para analizar video necesitás también el módulo de lectura de audio y video.</p>
      <div className="memory-button-wrap"><button className="btn btn-primary" disabled={!changed || save.isPending}>{save.isPending ? 'Guardando…' : 'Guardar'}</button><button type="button" className="btn" disabled={!!changed || save.isPending || process.isPending} onClick={() => process.mutate({})}>Procesar archivos guardados</button><Link to="/memory/processing">Ver progreso</Link></div>
    </form>}<ErrorBox error={query.error || save.error || process.error} />{process.isSuccess && <p role="status">Archivos encolados. Podés seguirlos en Procesamiento.</p>}
  </section>
}
function MediaModule({ module, status, onChange }: { module: typeof modules[number]; status: any; onChange: () => void }) {
  const action = useMutation({ mutationFn: (name: string) => api.post(`/memory/media/${module.key}/${name}`), onSuccess: onChange })
  const busy = status?.state === 'downloading', ready = status?.state === 'ready'
  return <div className="memory-callout"><strong>{module.title}</strong><p>{module.text}</p><small>{module.size}</small>
    {busy && <div role="status"><p>{status.file ?? 'Preparando módulo…'}{typeof status.percent === 'number' ? ` · ${Math.round(status.percent)}%` : ''}</p><progress max={100} value={status.percent} aria-label={`Descarga de ${module.title}`} /></div>}
    {ready ? <p className="badge badge-on">Listo para usar</p> : <p><button type="button" className="btn" disabled={!status || action.isPending} onClick={() => action.mutate(busy ? 'cancel' : 'install')}>{busy ? 'Cancelar descarga' : status?.state === 'error' ? 'Reintentar descarga' : 'Descargar módulo'}</button></p>}
    {status?.error && <p role="alert" className="memory-inline-error">{status.error}</p>}<ErrorBox error={action.error} />
  </div>
}
