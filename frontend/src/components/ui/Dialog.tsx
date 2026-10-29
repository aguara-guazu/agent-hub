import { useCallback, useEffect, useId, useRef } from "react"
import type { FormEvent, ReactNode } from "react"
import { Button, IconButton } from "./basics"
import { Layer, focusableIn, hasBlockingLayer, trapTab, useLayer } from "./layers"
import { uiText } from "./strings"

export interface DialogProps {
  open: boolean
  /** La acción: «Nuevo proyecto». Sin texto introductorio. */
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** Con `onSubmit`, Enter envía el formulario. */
  onSubmit?: () => void
  /** Bloquea el cierre mientras la operación está en curso. */
  busy?: boolean
  role?: "dialog" | "alertdialog"
  /** Selector del control que recibe el foco al abrir; por defecto, el primero. */
  initialFocus?: string
  /** Ancho máximo en px; por defecto 480 (el máximo del sistema). */
  width?: number
  /** X de cierre en el encabezado, además de Cancelar. */
  showClose?: boolean
}

/** Solo para crear (hasta 5 campos) o confirmar lo irreversible. Nunca un diálogo sobre otro. */
export function Dialog({ open, title, onClose, children, footer, onSubmit, busy = false, role = "dialog", initialFocus, width, showClose = false }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const close = useCallback(() => { if (!busy) onClose() }, [busy, onClose])
  const stacked = useRef(false)
  if (open && !stacked.current && hasBlockingLayer() && import.meta.env.DEV) {
    console.error(`Dialog «${title}» se abrió sobre otra capa modal; el sistema no admite modal sobre modal.`)
  }
  stacked.current = open
  useLayer(open, "modal", close)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const target = initialFocus ? panel.current?.querySelector<HTMLElement>(initialFocus) : focusableIn(panel.current)[0]
    ;(target ?? panel.current)?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [open, initialFocus])
  if (!open) return null
  const body = <>
    <div className="modal-h" style={showClose ? { display: "flex", alignItems: "flex-start", gap: "var(--sp-2)" } : undefined}>
      <h2 id={titleId} className="h2" style={{ flex: 1, minWidth: 0 }}>{title}</h2>
      {showClose && <IconButton icon="close" small variant="ghost" label={uiText("action.close")} disabled={busy} onClick={close} />}
    </div>
    <div className="modal-b">{children}</div>
    {footer && <div className="modal-f">{footer}</div>}
  </>
  return (
    <Layer>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 50, background: "var(--overlay)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "12vh var(--sp-5) var(--sp-5)", overflowY: "auto" }}
        onMouseDown={event => { if (event.target === event.currentTarget) close() }}
      >
        <div
          ref={panel}
          className="pop modal"
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          style={width ? { maxWidth: width } : undefined}
          onKeyDown={event => trapTab(event, panel.current)}
        >
          {onSubmit
            ? <form style={{ display: "contents" }} onSubmit={(event: FormEvent) => { event.preventDefault(); if (!busy) onSubmit() }}>{body}</form>
            : body}
        </div>
      </div>
    </Layer>
  )
}

export interface ConfirmDialogProps {
  open: boolean
  /** Pregunta que nombra el objeto: «¿Restaurar el respaldo del 28 de octubre?» */
  title: string
  /** Una línea: qué se pierde. */
  message: ReactNode
  /** Repite la acción: «Restaurar y reemplazar». Nunca «Aceptar». */
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
  role?: "dialog" | "alertdialog"
}

/** Confirmación de lo irreversible. El foco inicial va a «Cancelar». */
export function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel, destructive = true, busy = false, onConfirm, onClose, role = "alertdialog" }: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      busy={busy}
      role={role}
      initialFocus="[data-confirm-cancel]"
      width={420}
      footer={<>
        <Button variant="ghost" data-confirm-cancel="" onClick={onClose} disabled={busy}>{cancelLabel ?? uiText("action.cancel")}</Button>
        <Button variant={destructive ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
      </>}
    >
      {typeof message === "string" ? <p className="t2">{message}</p> : message}
    </Dialog>
  )
}
