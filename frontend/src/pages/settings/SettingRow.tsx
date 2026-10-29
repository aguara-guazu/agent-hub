import type { ReactNode } from "react"
import { errorKey, useT } from "../../i18n"
import { ApiError } from "../../lib/api"

/** Alto mínimo de una fila de ajuste, tomado de la plantilla C (assets/ejemplos/ajustes.html). */
const SETTING_ROW_MIN_HEIGHT = 64

export interface SettingRowProps {
  label: ReactNode
  /** Una línea de ayuda; nunca un párrafo que explique la interfaz. */
  hint?: ReactNode
  /** Con `htmlFor`, la etiqueta es un `<label>` del control. */
  htmlFor?: string
  monoHint?: boolean
  /** Identidad opcional a la izquierda (avatar de una fuente o integración). */
  lead?: ReactNode
  children?: ReactNode
}

/** Fila de ajuste: etiqueta y ayuda a la izquierda, control a la derecha. Va dentro de una `.list`. */
export function SettingRow({ label, hint, htmlFor, monoHint = false, lead, children }: SettingRowProps) {
  const labelStyle = { fontWeight: 500 }
  return (
    <div className="row" style={{ minHeight: SETTING_ROW_MIN_HEIGHT }}>
      {lead}
      <div className="row-main">
        {htmlFor
          ? <label className="md" htmlFor={htmlFor} style={labelStyle}>{label}</label>
          : <span className="md" style={labelStyle}>{label}</span>}
        {hint && <span className={monoHint ? "row-sub mono" : "row-sub"} title={typeof hint === "string" ? hint : undefined}>{hint}</span>}
      </div>
      {children && <div style={{ flex: "none", display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap", justifyContent: "flex-end", maxWidth: "60%" }}>{children}</div>}
    </div>
  )
}

/** Sección de Ajustes: título `.h2`, una acción secundaria opcional y su contenido. */
export function SettingsSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-h"><h2 className="h2">{title}</h2>{action}</div>
      {children}
    </section>
  )
}

/** Bloque «Opciones avanzadas» al final de una sección (plantilla C). */
export function AdvancedOptions({ children, label }: { children: ReactNode; label?: string }) {
  const { t } = useT("settings")
  return (
    <details>
      <summary style={{ cursor: "pointer", color: "var(--text-2)", fontWeight: 500 }}>{label ?? t("page.advanced")}</summary>
      <div style={{ marginTop: "var(--sp-3)", display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>{children}</div>
    </details>
  )
}

/** Detalle de un error para un toast: el mensaje del servidor si lo hay; si no, el texto genérico traducido. */
export function useErrorDetail() {
  const { t } = useT("errors")
  return (error: unknown): string => {
    if (error instanceof ApiError && error.message) return error.message
    return t(errorKey(error))
  }
}
