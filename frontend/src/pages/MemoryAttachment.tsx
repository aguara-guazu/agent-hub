import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { ErrorBox, useMemoryMutation } from '../lib/memory'

export function MemoryAttachment({ version, file, offsetMs, pageNumber }: { version: string; file: any; offsetMs?: number; pageNumber?: number }) {
  const process = useMemoryMutation('process_files')
  const [url, setUrl] = useState(''), [error, setError] = useState<Error | null>(null), [loading, setLoading] = useState(false)
  const [page, setPage] = useState(pageNumber ?? 1), [pageUrl, setPageUrl] = useState('')
  const media = useRef<HTMLMediaElement | null>(null)
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  useEffect(() => { if (media.current && offsetMs !== undefined) media.current.currentTime = offsetMs / 1000 }, [offsetMs, url])
  useEffect(() => { setPage(pageNumber ?? 1) }, [pageNumber])
  useEffect(() => {
    if (!url || file.mime_type !== 'application/pdf') return
    let cancelled = false, created = ''
    setPageUrl('')
    void api.download(`/memory/files/${version}/pages/${page}`).then(blob => {
      created = URL.createObjectURL(blob)
      if (cancelled) URL.revokeObjectURL(created); else { setPageUrl(created); setError(null) }
    }).catch(e => { if (!cancelled) setError(e as Error) })
    return () => { cancelled = true; if (created) URL.revokeObjectURL(created) }
  }, [url, file.mime_type, version, page])
  async function load() {
    setLoading(true); setError(null)
    try { setUrl(URL.createObjectURL(await api.download(`/memory/files/${version}`))) }
    catch (e) { setError(e as Error) } finally { setLoading(false) }
  }
  return <div className="memory-callout"><div className="spread"><strong>{file.filename}</strong><span className="badge">{file.mime_type} · {(file.size / 1_000_000).toFixed(1)} MB</span></div>
    <p>Original conservado en este equipo. El texto reconocido y las transcripciones automáticas son revisables; las citas conservan la versión analizada.</p>
    {(file.mime_type === 'application/pdf' || /^(image|audio|video)\//.test(file.mime_type)) && <button type="button" className="btn" disabled={process.isPending} onClick={() => process.mutate({ version_id: version, force: true })}>Analizar contenido localmente</button>}<ErrorBox error={process.error} />{process.isSuccess && <p role="status">Análisis encolado. Seguí el progreso en Procesamiento.</p>}
    {!url && <button type="button" className="btn" disabled={loading} onClick={() => void load()}>{loading ? 'Abriendo archivo…' : 'Abrir archivo guardado'}</button>}
    {url && <><a className="btn" href={url} download={file.filename}>Descargar original</a>
      {file.mime_type === 'application/pdf' && <><label>Página <input type="number" min={1} max={200} value={page} onChange={e => { const value = Number(e.target.value); if (Number.isInteger(value) && value >= 1 && value <= 200) setPage(value) }} /></label>{pageUrl && <img className="memory-attachment-image" src={pageUrl} alt={`Página ${page} de ${file.filename}`} />}</>}
      {file.mime_type.startsWith('image/') && <img className="memory-attachment-image" src={url} alt={file.filename} />}
      {file.mime_type.startsWith('audio/') && <audio ref={node => { media.current = node }} controls src={url} onLoadedMetadata={() => { if (media.current && offsetMs !== undefined) media.current.currentTime = offsetMs / 1000 }} />}
      {file.mime_type.startsWith('video/') && <video ref={node => { media.current = node }} controls src={url} onLoadedMetadata={() => { if (media.current && offsetMs !== undefined) media.current.currentTime = offsetMs / 1000 }} />}
    </>}<ErrorBox error={error} />
  </div>
}
