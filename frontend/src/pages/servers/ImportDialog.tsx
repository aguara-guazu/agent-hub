import { useState } from "react"
import { Button, Dialog, Field, Textarea, useToast } from "../../components/ui"
import { useT } from "../../i18n/useT"
import { createServer, parseImport, probeServer, putRule, useServersCache } from "../../lib/servers"
import type { ImportEntry, ImportProblem } from "../../lib/servers"
import { useFailDetail } from "./shared"

const PLACEHOLDER = "{\n  \"mcpServers\": {\n    \"github\": { \"command\": \"npx\", \"args\": [\"-y\", \"@modelcontextprotocol/server-github\"] }\n  }\n}"

/** Crea varios servidores desde la configuración de un cliente. Los que fallan quedan en el cuadro para corregirlos. */
export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, plural } = useT("servers")
  const common = useT("common").t
  const toast = useToast()
  const failDetail = useFailDetail()
  const refresh = useServersCache()
  const [text, setText] = useState("")
  const [problem, setProblem] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const describe = (value: ImportProblem) => value.code === "entry"
    ? t("importDialog.problems.entry", { name: value.name })
    : t(`importDialog.problems.${value.code}`)

  function close() {
    if (busy) return
    setProblem(undefined)
    onClose()
  }

  async function submit() {
    const { entries, problem: parseProblem } = parseImport(text)
    if (parseProblem) { setProblem(describe(parseProblem)); return }
    setProblem(undefined)
    setBusy(true)
    const failed: ImportEntry[] = []
    let firstError: { name: string; error: unknown } | null = null
    let created = 0
    for (const entry of entries) {
      try {
        const server = await createServer(entry.body)
        created += 1
        if (entry.disabled) await putRule({ type: "mcp_server", id: server.id, state: "off" })
        // El sondeo puede fallar sin invalidar el alta: el estado queda en la fila.
        await probeServer(server.id).catch(() => undefined)
      } catch (error) {
        failed.push(entry)
        firstError ??= { name: entry.name, error }
      }
    }
    await refresh()
    setBusy(false)
    if (created > 0) toast.success(plural("toast.imported", created))
    if (firstError) toast.error(t("toast.importFailed", { name: firstError.name }), failDetail(firstError.error))
    if (failed.length === 0) { setText(""); onClose(); return }
    const pending = Object.fromEntries(failed.map(entry => [entry.name, entry.raw]))
    setText(JSON.stringify({ mcpServers: pending }, null, 2))
    setProblem(t("importDialog.partial"))
  }

  return (
    <Dialog
      open={open}
      title={t("importDialog.title")}
      onClose={close}
      busy={busy}
      footer={<>
        <Button variant="ghost" onClick={close} disabled={busy}>{common("actions.cancel")}</Button>
        <Button variant="primary" onClick={() => void submit()} disabled={busy || !text.trim()}>{t("actions.importServers")}</Button>
      </>}
    >
      <Field label={t("importDialog.field")} hint={t("importDialog.hint")} error={problem}>
        <Textarea mono rows={10} value={text} placeholder={PLACEHOLDER} spellCheck={false} onChange={event => { setText(event.target.value); setProblem(undefined) }} />
      </Field>
    </Dialog>
  )
}
