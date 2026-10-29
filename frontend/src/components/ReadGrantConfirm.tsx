import { useState, type FormEvent } from "react"
import { Button, Dl, ErrorState, Field, Input, useToast } from "./ui"
import { useFormat, useT } from "../i18n/useT"
import { readGrantErrorCode, useConfirmReadRequest, useRejectReadRequest, type ReadRequest } from "../lib/read-grants"

export const readRequestAgent = (request: ReadRequest) => request.requester_nickname ?? request.requester_label

/**
 * Revisión de un pedido de lectura entre proyectos que espera a la persona. La frase se escribe acá y solo acá:
 * el servidor la valida y es la única forma de otorgar el permiso. Se monta en el panel de Inicio › Pendientes.
 */
export function ReadGrantConfirm({ request, onDone }: { request: ReadRequest; onDone: () => void }) {
  const { t } = useT("access")
  const format = useFormat()
  return (
    <>
      <Dl items={[
        { label: t("detail.agent"), value: readRequestAgent(request) },
        { label: t("detail.from"), value: request.requester_project_title },
        { label: t("detail.target"), value: request.target_project_title },
        { label: t("detail.reason"), value: request.reason ? <span style={{ overflowWrap: "anywhere" }}>{request.reason}</span> : null },
        { label: t("detail.elevatedBy"), value: request.elevated_by_label },
        { label: t("detail.note"), value: request.elevation_note },
        { label: t("detail.when"), value: format.date(request.elevated_at ?? request.created_at, "datetime") },
      ]} />
      <ConfirmForm key={request.id} request={request} onDone={onDone} />
    </>
  )
}

function ConfirmForm({ request, onDone }: { request: ReadRequest; onDone: () => void }) {
  const { t } = useT("access")
  const toast = useToast()
  const confirm = useConfirmReadRequest()
  const reject = useRejectReadRequest()
  const [phrase, setPhrase] = useState("")
  const agent = readRequestAgent(request)
  const busy = confirm.isPending || reject.isPending
  const example = request.requester_project_title
    ? t("example.withProject", { agent, source: request.requester_project_title, target: request.target_project_title })
    : t("example.withoutProject", { agent, target: request.target_project_title })
  const failure = confirm.error ?? reject.error
  const code = readGrantErrorCode(failure)
  const message = code ? t(`errors.${code}`, { agent, target: request.target_project_title }) : undefined

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!phrase.trim() || busy) return
    reject.reset()
    confirm.mutate({ id: request.id, phrase: phrase.trim() }, { onSuccess: () => { setPhrase(""); toast.success(t("toast.granted", { agent })); onDone() } })
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)", minWidth: 0 }} aria-busy={busy}>
      <Field label={t("field.label")} hint={t("field.hint")} {...(message ? { error: message } : {})}>
        <Input value={phrase} placeholder={example} autoComplete="off" spellCheck={false} maxLength={500} disabled={busy}
          onChange={event => { setPhrase(event.target.value); if (confirm.error) confirm.reset() }} />
      </Field>
      {failure && !code && <ErrorState error={failure} />}
      <div style={{ display: "flex", gap: "var(--sp-2)", justifyContent: "flex-end", flexWrap: "wrap" }}>
        <Button variant="ghost" disabled={busy}
          onClick={() => { confirm.reset(); reject.mutate({ id: request.id }, { onSuccess: () => { toast.success(t("toast.rejected")); onDone() } }) }}>
          {t("actions.reject")}
        </Button>
        <Button variant="primary" type="submit" disabled={busy || !phrase.trim()}>{t("actions.grant")}</Button>
      </div>
    </form>
  )
}
