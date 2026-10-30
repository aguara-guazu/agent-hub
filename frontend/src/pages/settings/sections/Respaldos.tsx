import { useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button, ConfirmDialog, List, SkeletonRows, useToast } from "../../../components/ui"
import { useT } from "../../../i18n"
import { api } from "../../../lib/api"
import { useMemoryStatus } from "../../../lib/memory"
import { useMemoryBanner } from "../MemoryBanner"
import { SettingRow, SettingsSection, useErrorDetail } from "../SettingRow"
import { useMemoryAction } from "../memory"

/** Límite de cuerpo de `POST /api/memory/restore` (packages/memory/src/routes.ts). */
const RESTORE_MAX_BYTES = 128_000_000

/**
 * Respaldos de la memoria: crear y descargar (`export_backup` + `/memory/backups/:id`) y restaurar en una memoria
 * vacía (`/memory/restore`). Restaurar es la única confirmación de la app. La API no lista respaldos anteriores ni
 * respalda la configuración del hub; los respaldos cifrados de proyectos compartidos están en Colaboración y red.
 */
export default function Respaldos() {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const status = useMemoryStatus()
  const ready = status.data?.ready === true
  const banner = useMemoryBanner()
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<{ name: string; body: unknown } | null>(null)
  const backup = useMemoryAction<{ id: string; download_url: string }>("export_backup", t("backups.createFailed"), async result => {
    try {
      const file = await api.download(result.download_url.replace(/^\/api/, ""))
      const url = URL.createObjectURL(file)
      const link = document.createElement("a")
      link.href = url
      link.download = `agenthub-memory-${result.id}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success(t("backups.created"))
    } catch (error) {
      toast.error(t("backups.downloadFailed"), detail(error))
    }
  })
  const restore = useMutation({
    mutationFn: (body: unknown) => api.post("/memory/restore", body),
    onSuccess: () => { setPending(null); void cache.invalidateQueries(); toast.success(t("backups.restored")) },
    onError: error => { setPending(null); toast.error(t("backups.restoreFailed"), detail(error)) },
  })
  async function pick(file?: File) {
    if (input.current) input.current.value = ""
    if (!file) return
    if (file.size > RESTORE_MAX_BYTES) { toast.error(t("backups.tooLarge")); return }
    try {
      setPending({ name: file.name, body: JSON.parse(await file.text()) })
    } catch {
      toast.error(t("backups.invalid"))
    }
  }
  return (
    <SettingsSection title={t("sections.respaldos")}>
      {banner}
      {status.isPending ? <SkeletonRows count={2} avatar={false} /> : (
        <List>
          <SettingRow label={t("backups.memory.label")} hint={t("backups.memory.hint")}>
            <Button small disabled={!ready || backup.isPending} onClick={() => backup.mutate({})}>{backup.isPending ? t("backups.creating") : t("backups.create")}</Button>
          </SettingRow>
          <SettingRow label={t("backups.restore.label")} hint={t("backups.restore.hint")}>
            <input ref={input} type="file" accept=".json,application/json" hidden onChange={event => void pick(event.target.files?.[0])} />
            <Button small variant="danger" disabled={!ready || restore.isPending} onClick={() => input.current?.click()}>{t("backups.restore.action")}</Button>
          </SettingRow>
        </List>
      )}
      <ConfirmDialog
        open={pending !== null}
        title={t("backups.restore.title", { file: pending?.name ?? "" })}
        message={t("backups.restore.message")}
        confirmLabel={t("backups.restore.confirm")}
        destructive
        busy={restore.isPending}
        onClose={() => { if (!restore.isPending) setPending(null) }}
        onConfirm={() => { if (pending) restore.mutate(pending.body) }}
      />
    </SettingsSection>
  )
}
