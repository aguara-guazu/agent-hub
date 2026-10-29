import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button, Dialog, Field, Input, useToast } from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import { invalidateAfterMachineChange } from "../../lib/queries"
import type { Machine } from "../../lib/types"

/** Respuesta de POST /machines/enroll. El token viaja en claro una única vez: el servidor guarda su hash. */
interface EnrollResponse { machine: Machine; token: string }

/** `agenthub` es el CLI incluido en la app de escritorio; guarda el token con permisos restrictivos. */
export function installCommand(token: string, baseUrl: string): string {
  return `agenthub enroll --url ${baseUrl} --token ${token}`
}

export function useCopy() {
  const toast = useToast()
  const { t } = useT("clients")
  const common = useT("common").t
  return async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(common("toast.copied"))
    } catch {
      toast.error(t("toast.copyFailed"), t("toast.copyFailedDetail"))
    }
  }
}

export function EnrollDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT("clients")
  const common = useT("common").t
  const toast = useToast()
  const cache = useQueryClient()
  const copy = useCopy()
  const [hostname, setHostname] = useState("")
  const [os, setOs] = useState("")
  const [daemon, setDaemon] = useState("")
  const [enrolled, setEnrolled] = useState<EnrollResponse | null>(null)
  const enroll = useMutation({
    mutationFn: () => api.post<EnrollResponse>("/machines/enroll", { hostname: hostname.trim(), os: os.trim(), daemon_version: daemon.trim() }),
    onSuccess: async response => {
      await invalidateAfterMachineChange(cache)
      setEnrolled(response)
    },
    onError: error => toast.error(t("toast.enrollFailed"), error.message),
  })
  function close() {
    setHostname("")
    setOs("")
    setDaemon("")
    setEnrolled(null)
    onClose()
  }

  if (enrolled) {
    const command = installCommand(enrolled.token, window.location.origin)
    return (
      <Dialog open={open} title={t("enroll.tokenTitle", { host: enrolled.machine.hostname })} onClose={close} role="alertdialog"
        footer={<Button variant="primary" onClick={close}>{common("actions.close")}</Button>}>
        <span className="t2" role="alert">{t("enroll.once")}</span>
        <Field label={t("enroll.token")}>
          <Input mono readOnly value={enrolled.token} onFocus={event => event.target.select()} />
        </Field>
        <Button small style={{ alignSelf: "flex-start" }} onClick={() => void copy(enrolled.token)}>{t("actions.copyToken")}</Button>
        <Field label={t("enroll.command")} hint={t("enroll.commandHint")}>
          <Input mono readOnly value={command} onFocus={event => event.target.select()} />
        </Field>
        <Button small style={{ alignSelf: "flex-start" }} onClick={() => void copy(command)}>{t("actions.copyCommand")}</Button>
      </Dialog>
    )
  }

  const valid = hostname.trim() !== ""
  return (
    <Dialog open={open} title={t("enroll.title")} onClose={close} busy={enroll.isPending}
      onSubmit={() => { if (valid) enroll.mutate() }}
      footer={<>
        <Button variant="ghost" onClick={close} disabled={enroll.isPending}>{common("actions.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={!valid || enroll.isPending}>{t("actions.generateToken")}</Button>
      </>}>
      <Field label={t("enroll.hostname")}>
        <Input value={hostname} autoComplete="off" onChange={event => setHostname(event.target.value)} />
      </Field>
      <Field label={t("enroll.os")} hint={t("enroll.optional")}>
        <Input value={os} autoComplete="off" onChange={event => setOs(event.target.value)} />
      </Field>
      <Field label={t("enroll.daemon")} hint={t("enroll.optional")}>
        <Input mono value={daemon} autoComplete="off" onChange={event => setDaemon(event.target.value)} />
      </Field>
    </Dialog>
  )
}
