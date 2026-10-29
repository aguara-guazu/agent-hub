/** Compatibilidad con las vistas aún no migradas: `Modal` y `ConfirmDialog` usan el `Dialog` del kit.
 *  Las vistas nuevas importan `Dialog` y `ConfirmDialog` desde `components/ui`. */

import type { ReactNode } from "react"
import { ConfirmDialog as KitConfirmDialog, Dialog } from "./ui/Dialog"

export interface ModalProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  busy?: boolean
}

export function Modal({ open, title, onClose, children, footer, width, busy = false }: ModalProps) {
  return <Dialog open={open} title={title} onClose={onClose} footer={footer} width={width} busy={busy} showClose>{children}</Dialog>
}

export interface ConfirmDialogProps {
  open: boolean
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}

export function ConfirmDialog({ confirmLabel = "Confirmar", destructive = false, ...rest }: ConfirmDialogProps) {
  return <KitConfirmDialog confirmLabel={confirmLabel} destructive={destructive} role="dialog" {...rest} />
}

export default Modal
