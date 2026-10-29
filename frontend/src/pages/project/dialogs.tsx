import { useRef, useState } from "react"
import type { DragEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Button, Dialog, Field, IconButton, Input, Select, Textarea, useToast } from "../../components/ui"
import { useT } from "../../i18n"
import { memoryCall } from "../../lib/memory"
import { MAX_FILE_BYTES, parseLocalDateTime, readBase64 } from "../../lib/projects"
import { useErrorText, useMemoryAction } from "./shared"

/** Nueva nota del proyecto: título + contenido. */
export function NoteDialog({ open, projectId, onClose }: { open: boolean; projectId: string; onClose: () => void }) {
  const { t } = useT("project")
  const common = useT("common").t
  const toast = useToast()
  const errorText = useErrorText()
  const [title, setTitle] = useState("")
  const [text, setText] = useState("")
  const [error, setError] = useState("")
  const create = useMemoryAction("create_entity", { quiet: true })
  const close = () => { if (!create.isPending) { setTitle(""); setText(""); setError(""); onClose() } }
  const submit = () => {
    if (!title.trim() || create.isPending) return
    create.mutate({ kind: "note", title: title.trim(), project_ids: [projectId], data: { text: text.trim() || title.trim() } }, {
      onSuccess: () => { toast.success(t("header.note.done")); setTitle(""); setText(""); setError(""); onClose() },
      onError: failure => setError(errorText(failure)),
    })
  }
  return (
    <Dialog
      open={open}
      title={t("header.note.title")}
      onClose={close}
      onSubmit={submit}
      busy={create.isPending}
      footer={<>
        <Button variant="ghost" onClick={close} disabled={create.isPending}>{common("actions.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={!title.trim() || create.isPending}>{t("header.note.submit")}</Button>
      </>}
    >
      <Field label={t("header.note.name")}><Input value={title} maxLength={500} onChange={event => setTitle(event.target.value)} /></Field>
      <Field label={t("header.note.text")}><Textarea rows={6} value={text} onChange={event => setText(event.target.value)} /></Field>
      {error && <p className="xs" role="alert" style={{ color: "var(--danger)" }}>{error}</p>}
    </Dialog>
  )
}

type SourceKind = "document" | "meeting" | "note"
const fileKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`

function fileSize(bytes: number, language: "es" | "en") {
  const format = new Intl.NumberFormat(language, { maximumFractionDigits: 1 })
  return bytes < 1_000_000 ? `${format.format(Math.max(1, Math.round(bytes / 1000)))} KB` : `${format.format(bytes / 1_000_000)} MB`
}

/**
 * Adjuntar archivos a un proyecto (`import_file` con `infer_metadata`): título, identificador y resumen los completa el procesamiento.
 * Los archivos que fallan quedan en la lista para reintentar.
 */
export function AttachDialog({ open, projectId, onClose }: { open: boolean; projectId: string; onClose: () => void }) {
  const { t, plural, language } = useT("project")
  const common = useT("common").t
  const toast = useToast()
  const errorText = useErrorText()
  const cache = useQueryClient()
  const picker = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [kind, setKind] = useState<SourceKind>("document")
  const [when, setWhen] = useState("")
  const [uploading, setUploading] = useState<number | null>(null)
  const busy = uploading !== null
  const problem = (file: File) => file.size === 0 ? t("header.attach.empty") : file.size > MAX_FILE_BYTES ? t("header.attach.tooLarge") : null
  const dateError = when.trim() && !parseLocalDateTime(when) ? t("header.attach.dateInvalid") : undefined
  const ready = files.length > 0 && !files.some(problem) && !dateError

  function add(list: FileList | null) {
    if (!list?.length) return
    const known = new Set(files.map(fileKey))
    setFiles([...files, ...Array.from(list).filter(file => !known.has(fileKey(file)))])
    setFailed({})
  }
  function close() {
    if (busy) return
    setFiles([]); setFailed({}); setWhen(""); setKind("document"); onClose()
  }
  async function upload() {
    if (!ready || busy) return
    const occurred = parseLocalDateTime(when)
    const errors: Record<string, string> = {}
    for (const [index, file] of files.entries()) {
      setUploading(index)
      try {
        await memoryCall("import_file", { filename: file.name, data_base64: await readBase64(file), kind, project_ids: [projectId], infer_metadata: true, ...(occurred ? { occurred_at: occurred } : {}) })
      } catch (error) { errors[fileKey(file)] = errorText(error) }
    }
    setUploading(null)
    void cache.invalidateQueries({ queryKey: ["memory"] })
    void cache.invalidateQueries({ queryKey: ["memory-status"] })
    const failedFiles = files.filter(file => errors[fileKey(file)])
    const saved = files.length - failedFiles.length
    if (saved) toast.success(plural("header.attach.done", saved))
    if (!failedFiles.length) { setFiles([]); setWhen(""); onClose(); return }
    toast.error(failedFiles.length === 1 ? t("header.attach.failed_one", { name: failedFiles[0]!.name }) : plural("header.attach.failed", failedFiles.length))
    setFiles(failedFiles)
    setFailed(errors)
  }
  function onDrop(event: DragEvent) {
    event.preventDefault()
    if (!busy) add(event.dataTransfer.files)
  }

  const kinds: { value: SourceKind; label: string }[] = [
    { value: "document", label: t("content.kind.document") },
    { value: "meeting", label: t("content.kind.meeting") },
    { value: "note", label: t("content.kind.note") },
  ]
  return (
    <Dialog
      open={open}
      title={t("header.attach.title")}
      onClose={close}
      onSubmit={() => void upload()}
      busy={busy}
      footer={<>
        <Button variant="ghost" onClick={close} disabled={busy}>{common("actions.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={!ready || busy}>
          {busy ? t("header.attach.uploading", { current: uploading + 1, total: files.length }) : plural("header.attach.submit", Math.max(1, files.length))}
        </Button>
      </>}
    >
      <Field label={t("header.attach.files")} hint={files.length ? undefined : t("header.attach.filesHint")}>
        <div
          className="empty"
          style={{ padding: "var(--sp-4)", border: "1px dashed var(--border-strong)", borderRadius: "var(--r)" }}
          onDragOver={event => event.preventDefault()}
          onDrop={onDrop}
        >
          <span className="t2 xs">{t("header.attach.drop")}</span>
          <Button small icon="document" disabled={busy} onClick={() => picker.current?.click()}>{t("header.attach.choose")}</Button>
          <input ref={picker} type="file" multiple hidden tabIndex={-1} aria-hidden="true" onChange={event => { add(event.target.files); event.target.value = "" }} />
        </div>
      </Field>
      {files.length > 0 && (
        <div className="list">
          {files.map((file, index) => {
            const issue = problem(file) ?? failed[fileKey(file)]
            return (
              <div className="row" key={fileKey(file)} style={{ minHeight: 0, padding: "var(--sp-2) var(--sp-3)" }}>
                <div className="row-main">
                  <span className="row-title" title={file.name}>{file.name}</span>
                  <span className="row-sub" style={issue ? { color: "var(--danger)" } : undefined}>{issue ?? fileSize(file.size, language)}</span>
                </div>
                <IconButton icon="close" small variant="ghost" label={t("header.attach.remove", { name: file.name })} disabled={busy || index === uploading} onClick={() => setFiles(files.filter(item => item !== file))} />
              </div>
            )
          })}
        </div>
      )}
      <Field label={t("header.attach.kind")}>
        <Select bare label={t("header.attach.kind")} value={kind} options={kinds} onChange={setKind} disabled={busy} />
      </Field>
      <Field label={t("header.attach.date")} hint={t("header.attach.dateHint")} error={dateError}>
        <Input mono value={when} placeholder="2026-10-29 14:30" disabled={busy} onChange={event => setWhen(event.target.value)} />
      </Field>
    </Dialog>
  )
}
