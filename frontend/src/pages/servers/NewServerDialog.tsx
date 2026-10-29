import { useMemo, useState } from "react"
import { Button, Dialog, Field, Input, Select, Textarea, useToast } from "../../components/ui"
import { useT } from "../../i18n/useT"
import { ApiError } from "../../lib/api"
import { buildPayload, createServer, draftOf, slugFrom } from "../../lib/servers"
import type { DraftIssue, ServerDraft } from "../../lib/servers"
import type { McpServer, ServerAuth, Transport } from "../../lib/types"
import { useFailDetail, useIssueText } from "./shared"

/** Alta corta (≤ 5 campos). Descripción, entorno, encabezados y credenciales se completan en el panel. */
export function NewServerDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (server: McpServer) => void }) {
  const { t } = useT("servers")
  const common = useT("common").t
  const status = useT("status").t
  const errors = useT("errors").t
  const toast = useToast()
  const failDetail = useFailDetail()
  const issueText = useIssueText()
  const [draft, setDraft] = useState<ServerDraft>(() => draftOf(null))
  const [slugEdited, setSlugEdited] = useState(false)
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [duplicate, setDuplicate] = useState(false)

  const { payload, issues } = useMemo(() => buildPayload(draft, null), [draft])
  const shown: DraftIssue[] = issues.filter(issue => touched.has(issue.field))
  const set = <K extends keyof ServerDraft>(key: K, value: ServerDraft[K]) => setDraft(current => ({ ...current, [key]: value }))
  const touch = (field: string) => setTouched(current => new Set(current).add(field))

  function reset() {
    setDraft(draftOf(null))
    setSlugEdited(false)
    setTouched(new Set())
    setDuplicate(false)
  }

  function close() {
    if (busy) return
    reset()
    onClose()
  }

  async function submit() {
    if (!payload) {
      setTouched(new Set(issues.map(issue => issue.field)))
      return
    }
    setBusy(true)
    try {
      const server = await createServer(payload)
      reset()
      onCreated(server)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setDuplicate(true)
      else toast.error(t("toast.saveFailed"), failDetail(error))
    } finally {
      setBusy(false)
    }
  }

  const stdio = draft.transport === "stdio"
  const slugError = duplicate ? errors("field.duplicate") : issueText(shown, "slug")
  return (
    <Dialog
      open={open}
      title={t("create.title")}
      onClose={close}
      busy={busy}
      onSubmit={() => void submit()}
      footer={<>
        <Button variant="ghost" onClick={close} disabled={busy}>{common("actions.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={busy || !payload} title={payload ? undefined : t("validation.fixFirst")}>{t("actions.add")}</Button>
      </>}
    >
      <Field label={t("panel.fields.name")} error={issueText(shown, "displayName")}>
        <Input
          value={draft.displayName}
          autoComplete="off"
          onChange={event => {
            const name = event.target.value
            setDraft(current => ({ ...current, displayName: name, slug: slugEdited ? current.slug : slugFrom(name) }))
            setDuplicate(false)
          }}
          onBlur={() => touch("displayName")}
        />
      </Field>
      <Field label={t("panel.fields.slug")} hint={t("panel.fields.slugHint")} error={slugError}>
        <Input mono value={draft.slug} autoComplete="off" onChange={event => { setSlugEdited(true); setDuplicate(false); set("slug", event.target.value) }} onBlur={() => touch("slug")} />
      </Field>
      <Field label={t("panel.fields.transport")} hint={t("create.transportHint")}>
        <Select<Transport>
          bare
          label={t("panel.fields.transport")}
          value={draft.transport}
          options={[{ value: "http", label: status("transport.http") }, { value: "stdio", label: status("transport.stdio") }]}
          onChange={value => set("transport", value)}
        />
      </Field>
      {stdio ? <>
        <Field label={t("panel.fields.command")} error={issueText(shown, "command")}>
          <Input mono value={draft.command} placeholder={t("create.commandPlaceholder")} autoComplete="off" onChange={event => set("command", event.target.value)} onBlur={() => touch("command")} />
        </Field>
        <Field label={t("panel.fields.args")} hint={t("panel.fields.argsHint")}>
          <Textarea mono rows={3} value={draft.args} onChange={event => set("args", event.target.value)} />
        </Field>
      </> : <>
        <Field label={t("panel.fields.url")} error={issueText(shown, "url")}>
          <Input mono value={draft.url} placeholder={t("create.urlPlaceholder")} autoComplete="off" onChange={event => set("url", event.target.value)} onBlur={() => touch("url")} />
        </Field>
        <Field label={t("panel.fields.auth")}>
          <Select<ServerAuth>
            bare
            label={t("panel.fields.auth")}
            value={draft.auth}
            options={[{ value: "none", label: t("panel.fields.authNone") }, { value: "oauth", label: t("panel.fields.authOauth") }]}
            onChange={value => set("auth", value)}
          />
        </Field>
      </>}
    </Dialog>
  )
}
