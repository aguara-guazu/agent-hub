import { useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button, Dialog, Field, Input, Textarea, useToast } from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import { MAX_ARCHIVE_BYTES } from "../../lib/projects"
import { useErrorText } from "../project/shared"

export type SharedMode = "join" | "restore"

/** Mismo contrato que `SharedProjectImport` (pages/MemorySharing): `/memory/sharing/call` con `join` o `restore`. */
export function SharedProjectDialog({ mode, onClose }: { mode: SharedMode | null; onClose: () => void }) {
  const { t } = useT("projects")
  const common = useT("common").t
  const toast = useToast()
  const errorText = useErrorText()
  const cache = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [invitation, setInvitation] = useState("")
  const [phrase, setPhrase] = useState("")
  const [archive, setArchive] = useState<{ name: string; value: unknown } | null>(null)
  const [error, setError] = useState("")
  const call = useMutation({
    mutationFn: (body: unknown) => api.post("/memory/sharing/call", body),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["sharing"] })
      void cache.invalidateQueries({ queryKey: ["memory"] })
      toast.success(t(mode === "restore" ? "restore.done" : "join.done"))
      reset()
      onClose()
    },
    onError: failure => setError(errorText(failure)),
  })
  const busy = call.isPending
  const ready = mode === "join" ? invitation.trim().length > 0 : archive !== null

  function reset() { setInvitation(""); setPhrase(""); setArchive(null); setError("") }
  function close() { if (!busy) { reset(); onClose() } }

  function submit() {
    if (!ready || busy) return
    const secret = phrase.trim() ? { phrase: phrase.trim() } : {}
    if (mode === "join") {
      let parsed: unknown
      try { parsed = JSON.parse(invitation) } catch { setError(t("join.invalid")); return }
      call.mutate({ operation: "join", invitation: parsed, ...secret })
    } else {
      call.mutate({ operation: "restore", archive: archive!.value, ...secret })
    }
  }

  function pick(file: File | undefined) {
    if (!file) return
    if (file.size > MAX_ARCHIVE_BYTES) { setArchive(null); setError(t("restore.tooLarge")); return }
    void file.text()
      .then(text => { setArchive({ name: file.name, value: JSON.parse(text) }); setError("") })
      .catch(() => { setArchive(null); setError(t("restore.unreadable")) })
  }

  return (
    <Dialog
      open={mode !== null}
      title={t(mode === "restore" ? "restore.title" : "join.title")}
      onClose={close}
      onSubmit={submit}
      busy={busy}
      footer={<>
        <Button variant="ghost" onClick={close} disabled={busy}>{common("actions.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={!ready || busy}>{t(mode === "restore" ? "restore.submit" : "join.submit")}</Button>
      </>}
    >
      {mode === "join" && (
        <Field label={t("join.invitation")} hint={t("join.invitationHint")}>
          <Textarea rows={5} mono value={invitation} onChange={event => { setInvitation(event.target.value); setError("") }} />
        </Field>
      )}
      {mode === "restore" && (
        <Field label={t("restore.file")} hint={archive ? undefined : t("restore.fileHint")}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", minWidth: 0 }}>
            <Button icon="add" onClick={() => input.current?.click()} disabled={busy}>{t(archive ? "restore.change" : "restore.choose")}</Button>
            {archive && <span className="mono xs t2 trunc" title={archive.name}>{archive.name}</span>}
            <input ref={input} type="file" accept=".hubproject,.json" hidden tabIndex={-1} aria-hidden="true" onChange={event => { pick(event.target.files?.[0]); event.target.value = "" }} />
          </div>
        </Field>
      )}
      <Field label={t(mode === "restore" ? "restore.phrase" : "join.phrase")} hint={t(mode === "restore" ? "restore.phraseHint" : "join.phraseHint")}>
        <Input type="password" autoComplete="off" value={phrase} onChange={event => setPhrase(event.target.value)} />
      </Field>
      {error && <p className="xs" role="alert" style={{ color: "var(--danger)" }}>{error}</p>}
    </Dialog>
  )
}
