import { createContext, useCallback, useContext, useEffect, useRef } from "react"
import type { ReactNode } from "react"
import { Button, IconButton } from "./basics"
import { useLayer } from "./layers"
import { useT } from "../../i18n"

export interface PanelProps {
  /** Nombre accesible del panel (normalmente el título del elemento). */
  label: string
  onClose: () => void
  children: ReactNode
  /** Editores de texto largos: 520 px en lugar de 440 px. */
  wide?: boolean
  /** Con cambios sin guardar, Escape y la X no cierran: se avisa en el pie. */
  dirty?: boolean
  onBlockedClose?: () => void
}

/** Ver y editar el elemento seleccionado. Escape o la X lo cierran. */
export function Panel({ label, onClose, children, wide = false, dirty = false, onBlockedClose }: PanelProps) {
  const root = useRef<HTMLElement>(null)
  const close = useCallback(() => {
    if (dirty) onBlockedClose?.()
    else onClose()
  }, [dirty, onBlockedClose, onClose])
  useLayer(true, "panel", close)
  useEffect(() => { root.current?.focus() }, [])
  return (
    <aside
      ref={root}
      className="panel"
      aria-label={label}
      tabIndex={-1}
      style={wide ? { maxWidth: 520, flexBasis: 520 } : undefined}
    >
      <CloseContext.Provider value={close}>{children}</CloseContext.Provider>
    </aside>
  )
}

const CloseContext = createContext<() => void>(() => undefined)

/** Identidad + estado + acciones («…»), con la X al final. */
export function PanelHeader({ lead, title, status, actions }: { lead?: ReactNode; title: ReactNode; status?: ReactNode; actions?: ReactNode }) {
  const close = useContext(CloseContext)
  const { t } = useT("common")
  return (
    <div className="panel-h">
      {lead}
      <div className="row-main" style={{ gap: "var(--sp-2)" }}>
        <h2 className="h3 trunc" title={typeof title === "string" ? title : undefined}>{title}</h2>
        {status && <div>{status}</div>}
      </div>
      <div style={{ display: "flex", gap: "var(--sp-1)", flex: "none" }}>
        {actions}
        <IconButton icon="close" label={t("a11y.closePanel")} variant="ghost" small onClick={close} />
      </div>
    </div>
  )
}

export function PanelBody({ children }: { children: ReactNode }) {
  return <div className="panel-b">{children}</div>
}

/** Un solo modelo de guardado por panel: `autosave`, o `onSave` + `onDiscard` (activos solo con cambios). */
export function PanelFooter({ autosave = false, dirty = false, saving = false, onSave, onDiscard, warning }: { autosave?: boolean; dirty?: boolean; saving?: boolean; onSave?: () => void; onDiscard?: () => void; warning?: boolean }) {
  const { t } = useT("common")
  if (autosave) return <div className="panel-f"><span className="xs t3" style={{ marginRight: "auto" }}>{t("states.autosave")}</span></div>
  return (
    <div className="panel-f">
      {warning && <span className="xs" role="status" style={{ marginRight: "auto", color: "var(--warn)" }}>{t("states.unsavedClose")}</span>}
      <Button variant="ghost" disabled={!dirty || saving} onClick={onDiscard}>{t("actions.discard")}</Button>
      <Button variant={warning ? "primary" : "default"} disabled={!dirty || saving} onClick={onSave}>{t("actions.saveChanges")}</Button>
    </div>
  )
}
