import { useCallback } from "react"
import { errorKey } from "../../i18n/errors"
import { useT } from "../../i18n/useT"
import { ApiError } from "../../lib/api"
import type { DraftIssue } from "../../lib/servers"

/** Detalle de un error para un toast: el motivo de validación del servidor (422) o la causa general traducida. */
export function useFailDetail() {
  const { t } = useT("errors")
  return useCallback((error: unknown): string => {
    if (error instanceof ApiError && error.status === 422 && error.message) return error.message
    return t(errorKey(error))
  }, [t])
}

/** Primer problema de cada campo, ya traducido. */
export function useIssueText() {
  const { t } = useT("servers")
  return useCallback((issues: readonly DraftIssue[], field: DraftIssue["field"]): string | undefined => {
    const issue = issues.find(item => item.field === field)
    if (!issue) return undefined
    return t(`validation.${issue.code}` as "validation.required", { name: issue.name, line: issue.line })
  }, [t])
}
