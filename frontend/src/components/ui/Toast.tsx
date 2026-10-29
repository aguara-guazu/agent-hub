import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Icon, type IconName } from "../Icon"
import { Button, IconButton } from "./basics"
import { useTheme } from "../../lib/theme"
import { cx } from "./layers"
import { uiText } from "./strings"

export type ToastKind = "info" | "success" | "error"

export interface ToastAction { label: string; onClick: () => void }

export interface ToastOptions {
  kind?: ToastKind
  message: string
  /** Segunda línea opcional, por ejemplo el detalle del servicio. */
  detail?: string
  /** Muestra «Deshacer»; se llama si la persona lo usa antes de que venza. */
  undo?: () => void
  /** Se llama cuando el aviso vence o lo reemplaza otro sin que se haya deshecho. */
  onCommit?: () => void
  /** Acción distinta de Deshacer: «Ver en Actividad», «Reintentar». */
  action?: ToastAction
  /** Milisegundos; 6 s por defecto, 10 s para errores. */
  duration?: number
}

export interface Toast extends ToastOptions { id: string; kind: ToastKind }

export interface ToastApi {
  /** Devuelve el id, para poder cerrarlo antes de tiempo. */
  push: (kind: ToastKind, message: string, detail?: string) => string
  info: (message: string, detail?: string) => string
  success: (message: string, detail?: string) => string
  error: (message: string, detail?: string) => string
  /** Aviso completo: con Deshacer, acción o duración propia. */
  show: (options: ToastOptions) => string
  dismiss: (id: string) => void
  clear: () => void
}

const DEFAULT_MS = 6000
const ERROR_MS = 10000

const ToastContext = createContext<ToastApi | null>(null)

let counter = 0

/** Un aviso a la vez, abajo a la izquierda: el nuevo reemplaza al anterior y el anterior se confirma. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null)
  const current = useRef<Toast | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const finish = useCallback((id: string, undone: boolean) => {
    const active = current.current
    if (!active || active.id !== id) return
    clearTimeout(timer.current)
    current.current = null
    setToast(null)
    if (undone) active.undo?.()
    else active.onCommit?.()
  }, [])

  const show = useCallback((options: ToastOptions) => {
    if (current.current) finish(current.current.id, false)
    counter += 1
    const next: Toast = { ...options, kind: options.kind ?? "success", id: `toast-${counter}` }
    current.current = next
    setToast(next)
    timer.current = setTimeout(() => finish(next.id, false), options.duration ?? (next.kind === "error" ? ERROR_MS : DEFAULT_MS))
    return next.id
  }, [finish])

  const dismiss = useCallback((id: string) => finish(id, false), [finish])
  const clear = useCallback(() => { if (current.current) finish(current.current.id, false) }, [finish])

  useEffect(() => () => clearTimeout(timer.current), [])

  const api = useMemo<ToastApi>(() => {
    const push = (kind: ToastKind, message: string, detail?: string) => show({ kind, message, detail })
    return {
      push,
      info: (message, detail) => push("info", message, detail),
      success: (message, detail) => push("success", message, detail),
      error: (message, detail) => push("error", message, detail),
      show,
      dismiss,
      clear,
    }
  }, [show, dismiss, clear])

  const theme = useTheme()
  const icon: IconName = toast?.kind === "error" ? "error" : toast?.kind === "info" ? "info" : "done"
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={cx("ah", theme.className)} aria-live="polite" style={{ background: "transparent", position: "fixed", left: "var(--sp-5)", bottom: "var(--sp-5)", zIndex: 70, maxWidth: "min(var(--panel-w), calc(100vw - 2 * var(--sp-5)))" }}>
          {toast && (
            <div className={cx("toast", `toast-${toast.kind}`)} role={toast.kind === "error" ? "alert" : "status"}>
              <Icon name={icon} style={{ color: toast.kind === "error" ? "var(--danger)" : toast.kind === "info" ? "var(--info)" : "var(--ok)" }} />
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span>{toast.message}</span>
                {toast.detail && <span className="xs t3 clamp2">{toast.detail}</span>}
              </div>
              {toast.undo && <Button small variant="ghost" style={{ color: "var(--accent-text)" }} onClick={() => finish(toast.id, true)}>{uiText("action.undo")}</Button>}
              {toast.action && <Button small variant="ghost" style={{ color: "var(--accent-text)" }} onClick={() => { const action = toast.action!; finish(toast.id, false); action.onClick() }}>{toast.action.label}</Button>}
              {!toast.undo && <IconButton small variant="ghost" icon="close" label={uiText("action.close")} onClick={() => finish(toast.id, false)} />}
            </div>
          )}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  if (context === null) throw new Error("useToast necesita estar dentro de <ToastProvider>")
  return context
}
