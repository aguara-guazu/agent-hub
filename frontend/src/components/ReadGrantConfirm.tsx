import { useState, type FormEvent } from "react"
import { Button, Chip, Empty, ErrorState, Field, Input, List, Row, SkeletonRows, useToast } from "./ui"
import { useFormat, useT } from "../i18n/useT"
import { readGrantErrorCode, useConfirmReadRequest, usePendingReadRequests, useRejectReadRequest, type ReadRequest } from "../lib/read-grants"

const agentName = (request: ReadRequest) => request.requester_nickname ?? request.requester_label

/**
 * Pedidos de lectura entre proyectos que esperan a la persona. La frase se escribe acá y solo acá:
 * el servidor la valida y es la única forma de otorgar el permiso. Pensado para la bandeja de Inicio.
 */
export function ReadGrantConfirm() {
  const { t } = useT("access")
  const { relative } = useFormat()
  const query = usePendingReadRequests()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (query.isPending) return <SkeletonRows count={2} label={t("list")} />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  const items = query.data.items
  if (!items.length) return <Empty icon="collaboration" title={t("empty")} />
  const selected = items.find(item => item.id === selectedId) ?? items[0]!

  return (
    <section aria-label={t("list")} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)", minWidth: 0 }}>
      <List>
        {items.map(request => (
          <Row
            key={request.id}
            title={t("row.title", { agent: agentName(request), target: request.target_project_title })}
            sub={[request.reason, request.elevated_by_label && t("row.elevated", { leader: request.elevated_by_label }),
              relative(request.elevated_at ?? request.created_at)].filter(Boolean).join(" · ")}
            meta={<Chip tone="warn">{t("pending")}</Chip>}
            selected={items.length > 1 && request.id === selected.id}
            {...(items.length > 1 ? { onOpen: () => setSelectedId(request.id) } : {})}
          />
        ))}
      </List>
      <ConfirmForm key={selected.id} request={selected} />
    </section>
  )
}

function ConfirmForm({ request }: { request: ReadRequest }) {
  const { t } = useT("access")
  const toast = useToast()
  const confirm = useConfirmReadRequest()
  const reject = useRejectReadRequest()
  const [phrase, setPhrase] = useState("")
  const agent = agentName(request)
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
    confirm.mutate({ id: request.id, phrase: phrase.trim() }, { onSuccess: () => { setPhrase(""); toast.success(t("toast.granted", { agent })) } })
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
          onClick={() => { confirm.reset(); reject.mutate({ id: request.id }, { onSuccess: () => toast.success(t("toast.rejected")) }) }}>
          {t("actions.reject")}
        </Button>
        <Button variant="primary" type="submit" disabled={busy || !phrase.trim()}>{t("actions.grant")}</Button>
      </div>
    </form>
  )
}
