import { useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button, ConfirmDialog, List, useToast } from "../../../components/ui"
import { useT } from "../../../i18n"
import { api } from "../../../lib/api"
import { useMemoryStatus } from "../../../lib/memory"
import { SettingRow, SettingsSection, useErrorDetail } from "../SettingRow"
import { useMemoryAction } from "../memory"

/**
 * Puente hasta la tanda 2 (dueño: ajustes-b): crear y descargar un respaldo de la memoria y restaurarlo en una
 * memoria vacía, como hacía la vista previa de Fuentes. Restaurar es la única confirmación de Ajustes.
 * Contrato: `export default` sin props; la sección renderiza su propio `SettingsSection`.
 */
export default function Respaldos() {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const status = useMemoryStatus()
  const ready = status.data?.ready === true
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<{ name: string; body: unknown } | null>(null)
  const backup = useMemoryAction<{ id: string; download_url: string }>("export_backup", t("bridge.backups.createFailed"), async result => {
    try {
      const file = await api.download(result.download_url.replace(/^\/api/, ""))
      const url = URL.createObjectURL(file)
      const link = document.createElement("a")
      link.href = url
      link.download = `agenthub-memory-${result.id}.json`
      link.click()
      URL.revokeObjectURL(url)
      toast.success(t("bridge.backups.created"))
    } catch {
      toast.error(t("bridge.backups.downloadFailed"))
    }
  })
  const restore = useMutation({
    mutationFn: (body: unknown) => api.post("/memory/restore", body),
    onSuccess: () => { setPending(null); void cache.invalidateQueries(); toast.success(t("bridge.backups.restored")) },
    onError: error => { setPending(null); toast.error(t("bridge.backups.restoreFailed"), detail(error)) },
  })
  async function pick(file?: File) {
    if (input.current) input.current.value = ""
    if (!file) return
    try {
      setPending({ name: file.name, body: JSON.parse(await file.text()) })
    } catch {
      toast.error(t("bridge.backups.invalid"))
    }
  }
  return (
    <SettingsSection title={t("sections.respaldos")} action={<Button small disabled={!ready || backup.isPending} onClick={() => backup.mutate({})}>{t("bridge.backups.create")}</Button>}>
      <List>
        <SettingRow label={t("bridge.backups.restoreLabel")} hint={t("bridge.backups.restoreHint")}>
          <input ref={input} type="file" accept=".json,application/json" hidden onChange={event => void pick(event.target.files?.[0])} />
          <Button small variant="danger" disabled={!ready || restore.isPending} onClick={() => input.current?.click()}>{t("bridge.backups.restore")}</Button>
        </SettingRow>
      </List>
      <ConfirmDialog
        open={pending !== null}
        title={t("bridge.backups.restoreTitle", { file: pending?.name ?? "" })}
        message={t("bridge.backups.restoreMessage")}
        confirmLabel={t("bridge.backups.restoreConfirm")}
        cancelLabel={t("bridge.backups.cancel")}
        destructive
        busy={restore.isPending}
        onClose={() => setPending(null)}
        onConfirm={() => restore.mutate(pending!.body)}
      />
    </SettingsSection>
  )
}
