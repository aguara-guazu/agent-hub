/** Avisos efimeros. Es el unico canal para errores que no bloquean la pantalla,
 *  en particular los de la matriz, donde un toggle puede fallar mientras la
 *  persona ya paso a tocar otros. */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: string
  kind: ToastKind
  message: string
  /** Segunda linea opcional: el detalle tecnico del backend. */
  detail?: string
}

export interface ToastApi {
  /** Devuelve el id, para poder cerrarlo antes de tiempo. */
  push: (kind: ToastKind, message: string, detail?: string) => string
  info: (message: string, detail?: string) => string
  success: (message: string, detail?: string) => string
  error: (message: string, detail?: string) => string
  dismiss: (id: string) => void
  clear: () => void
}

/** Cuanto vive cada tipo de aviso. Los errores duran mas porque suelen traer
 *  informacion que hay que leer, no solo confirmar. */
const TTL_MS: Record<ToastKind, number> = { info: 5000, success: 4000, error: 10000 }

const ToastContext = createContext<ToastApi | null>(null)

let counter = 0
function nextId(): string {
  counter += 1
  return `toast-${counter}`
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((current) => current.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (kind: ToastKind, message: string, detail?: string) => {
      const id = nextId()
      setToasts((current) => [...current, { id, kind, message, detail }])
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TTL_MS[kind]),
      )
      return id
    },
    [dismiss],
  )

  const clear = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
    setToasts([])
  }, [])

  // Los timers son recursos del provider: si se desmonta con avisos vivos, quedan colgados.
  const pending = timers.current
  useEffect(() => () => pending.forEach(clearTimeout), [pending])

  const api = useMemo<ToastApi>(
    () => ({
      push,
      info: (message, detail) => push('info', message, detail),
      success: (message, detail) => push('success', message, detail),
      error: (message, detail) => push('error', message, detail),
      dismiss,
      clear,
    }),
    [push, dismiss, clear],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
            <div className="toast-body">
              <div className="toast-message">{toast.message}</div>
              {toast.detail && <div className="toast-detail">{toast.detail}</div>}
            </div>
            <button type="button" className="toast-close" aria-label="Cerrar aviso" onClick={() => dismiss(toast.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (ctx === null) throw new Error('useToast necesita estar dentro de <ToastProvider>')
  return ctx
}

export default ToastProvider
