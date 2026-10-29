import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button, Tag } from "../../components/ui/basics"
import { MoreMenu } from "../../components/ui/actions"
import { ErrorState } from "../../components/ui/display"
import { Field, Input } from "../../components/ui/fields"
import { useToast } from "../../components/ui/Toast"
import { useFormat, useT } from "../../i18n/useT"
import { api } from "../../lib/api"
import { useMemoryAction, type StoredFile } from "../../lib/memory-view"

const ANALYZABLE = /^(application\/pdf|image\/|audio\/|video\/)/

/** Archivo original guardado en este equipo: abrir, descargar, analizar y vista previa (PDF por página, imagen, audio, video). */
export function Attachment({ version, file, offsetMs, pageNumber }: { version: string; file: StoredFile; offsetMs?: number; pageNumber?: number }) {
  const { t } = useT("memory"), format = useFormat(), toast = useToast(), navigate = useNavigate()
  const [url, setUrl] = useState(""), [error, setError] = useState<unknown>(null), [loading, setLoading] = useState(false)
  const [page, setPage] = useState(pageNumber ?? 1), [pageUrl, setPageUrl] = useState("")
  const media = useRef<HTMLMediaElement | null>(null)
  const isPdf = file.mime_type === "application/pdf"
  const analyze = useMemoryAction("process_files", () => toast.show({ kind: "info", message: t("file.analyzing"), action: { label: t("file.viewActivity"), onClick: () => navigate("/activity?tab=procesamiento") } }))
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  useEffect(() => { setPage(pageNumber ?? 1) }, [pageNumber])
  useEffect(() => { if (media.current && offsetMs !== undefined) media.current.currentTime = offsetMs / 1000 }, [offsetMs, url])
  useEffect(() => {
    if (!url || !isPdf) return
    let cancelled = false, created = ""
    setPageUrl("")
    void api.download(`/memory/files/${version}/pages/${page}`).then(blob => {
      created = URL.createObjectURL(blob)
      if (cancelled) URL.revokeObjectURL(created)
      else { setPageUrl(created); setError(null) }
    }).catch(failure => { if (!cancelled) setError(failure) })
    return () => { cancelled = true; if (created) URL.revokeObjectURL(created) }
  }, [url, isPdf, version, page])
  async function load() {
    setLoading(true); setError(null)
    try { setUrl(URL.createObjectURL(await api.download(`/memory/files/${version}`))) }
    catch (failure) { setError(failure) } finally { setLoading(false) }
  }
  // En la app de escritorio el PDF se abre en el lector del sistema; la vista por página queda si no hay uno asociado.
  const openStoredPdf = isPdf ? window.agentHub?.openStoredPdf : undefined
  async function open() {
    if (!openStoredPdf) return load()
    setLoading(true); setError(null)
    try { if (!(await openStoredPdf(version)).ok) await load() }
    catch { await load() } finally { setLoading(false) }
  }
  const size = file.size < 1_000_000 ? `${format.number(Math.max(1, Math.round(file.size / 1000)))} KB` : `${format.number(file.size / 1_000_000, { maximumFractionDigits: 1 })} MB`
  const onMediaReady = () => { if (media.current && offsetMs !== undefined) media.current.currentTime = offsetMs / 1000 }
  return (
    <section className="section card card-pad">
      <div className="section-h">
        <div className="row-main">
          <span className="row-title" title={file.filename}>{file.filename}</span>
          <span className="row-sub">{size}</span>
        </div>
        <Tag>{t(`file.type.${fileFamily(file.mime_type)}`)}</Tag>
        {url
          ? <a className="btn btn-sm" href={url} download={file.filename}>{t("file.download")}</a>
          : <Button small disabled={loading} onClick={() => void open()}>{loading ? t("file.opening") : t("file.open")}</Button>}
        {ANALYZABLE.test(file.mime_type) && <MoreMenu small ghost items={[{ label: t("file.analyze"), onSelect: () => analyze.mutate({ version_id: version, force: true }), disabled: analyze.isPending }]} />}
      </div>
      {url && isPdf && <>
        <div style={{ maxWidth: 140 }}>
          <Field label={t("file.page")}>
            <Input mono type="number" min={1} max={200} value={page} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 200) setPage(value) }} />
          </Field>
        </div>
        {pageUrl && <img src={pageUrl} alt={t("file.pageAlt", { page, name: file.filename })} style={{ maxWidth: "100%", borderRadius: "var(--r-sm)", border: "1px solid var(--border)" }} />}
      </>}
      {url && file.mime_type.startsWith("image/") && <img src={url} alt={file.filename} style={{ maxWidth: "100%", borderRadius: "var(--r-sm)", border: "1px solid var(--border)" }} />}
      {url && file.mime_type.startsWith("audio/") && <audio ref={node => { media.current = node }} controls src={url} onLoadedMetadata={onMediaReady} style={{ width: "100%" }} />}
      {url && file.mime_type.startsWith("video/") && <video ref={node => { media.current = node }} controls src={url} onLoadedMetadata={onMediaReady} style={{ maxWidth: "100%" }} />}
      {Boolean(error) && <ErrorState error={error} onRetry={() => void load()} />}
    </section>
  )
}

function fileFamily(mime: string): "pdf" | "image" | "audio" | "video" | "text" | "other" {
  if (mime === "application/pdf") return "pdf"
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime.startsWith("text/") || mime === "application/json") return "text"
  return "other"
}
