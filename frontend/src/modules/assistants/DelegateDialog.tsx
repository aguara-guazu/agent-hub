import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { Role } from "@agenthub/shared/assistants"
import { Button, Dialog, Field, Select, Textarea, describeError, useToast } from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import type { Project } from "./data"

const ROLES = ["secretary", "pm", "developer"] as const

export interface DelegateDialogProps {
  open: boolean
  onClose: () => void
  projects: readonly Project[]
  /** Project preselected from the filter or from the issue on screen. */
  project: string
}

/** Delegate work to a role of one project: three fields. The request id makes a repeated submit idempotent. */
export function DelegateDialog({ open, onClose, projects, project }: DelegateDialogProps) {
  const { t } = useT("assistants")
  const common = useT("common").t
  const toast = useToast()
  const cache = useQueryClient()
  const [target, setTarget] = useState(project)
  const [role, setRole] = useState<Role>("pm")
  const [objective, setObjective] = useState("")
  const [request, setRequest] = useState(() => crypto.randomUUID())
  const [error, setError] = useState("")
  useEffect(() => {
    if (open) setTarget(project)
  }, [open, project])
  const send = useMutation({
    mutationFn: () => api.post("/assistants/work/" + target, { role, objective: objective.trim(), request_id: request }),
    onSuccess: () => {
      toast.success(t("delegated"))
      setObjective("")
      setError("")
      setRequest(crypto.randomUUID())
      onClose()
      return cache.invalidateQueries({ queryKey: ["assistants", "work"] })
    },
    onError: (failure) => setError(failure instanceof Error && failure.message ? failure.message : describeError(failure)),
  })
  const valid = !!target && objective.trim().length > 0
  const close = () => {
    if (!send.isPending) onClose()
  }
  return (
    <Dialog
      open={open}
      title={t("delegateTask")}
      onClose={close}
      onSubmit={() => {
        if (valid && !send.isPending) send.mutate()
      }}
      busy={send.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={send.isPending}>
            {common("actions.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={!valid || send.isPending}>
            {t("delegate")}
          </Button>
        </>
      }
    >
      <Field label={t("project")}>
        <Select
          bare
          label={t("project")}
          value={target}
          onChange={setTarget}
          placeholder={t("chooseOptional")}
          options={projects.filter((p) => p.active).map((p) => ({ value: p.id, label: p.title }))}
        />
      </Field>
      <Field label={t("role")}>
        <Select bare label={t("role")} value={role} onChange={setRole} options={ROLES.map((r) => ({ value: r, label: t(r) }))} />
      </Field>
      <Field label={t("objective")}>
        <Textarea rows={3} maxLength={4000} value={objective} onChange={(event) => setObjective(event.target.value)} />
      </Field>
      {error && (
        <p className="xs" role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </Dialog>
  )
}
