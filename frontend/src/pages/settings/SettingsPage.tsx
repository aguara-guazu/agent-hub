import { Component, Suspense, lazy } from "react"
import type { ComponentType, LazyExoticComponent, ReactNode } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ErrorState, SkeletonRows, cx } from "../../components/ui"
import { useT } from "../../i18n"

/**
 * Ajustes (plantilla C). El índice y la sección activa salen de `?section=`; un valor desconocido muestra General.
 *
 * Contrato de secciones: cada una es `pages/settings/sections/<Nombre>.tsx` con `export default` de un componente
 * sin props que renderiza su propio `SettingsSection` (ver `SettingRow.tsx`). La página no les pasa estado: cada
 * sección consulta y guarda lo suyo con un solo modelo de guardado. Los ids de `SECTION_IDS` son públicos
 * (enlaces del escritorio, notificaciones y redirecciones de `App.tsx`); no se renombran.
 */
export const SECTION_IDS = ["general", "fuentes", "ia", "automatizaciones", "colaboracion", "integraciones", "respaldos", "sistema"] as const
export type SectionId = (typeof SECTION_IDS)[number]

const SECTIONS: Record<SectionId, LazyExoticComponent<ComponentType>> = {
  general: lazy(() => import("./sections/General")),
  fuentes: lazy(() => import("./sections/Fuentes")),
  ia: lazy(() => import("./sections/IA")),
  automatizaciones: lazy(() => import("./sections/Automatizaciones")),
  colaboracion: lazy(() => import("./sections/Colaboracion")),
  integraciones: lazy(() => import("./sections/Integraciones")),
  respaldos: lazy(() => import("./sections/Respaldos")),
  sistema: lazy(() => import("./sections/Sistema")),
}

function isSection(value: string | null): value is SectionId {
  return value !== null && (SECTION_IDS as readonly string[]).includes(value)
}

/** Ancho del índice de secciones y de la página, tomados del ejemplo de la plantilla C. */
const INDEX_WIDTH = 200
const PAGE_MAX_WIDTH = 1040

/** Aísla la falla de carga de una sección (chunk no disponible) sin tirar el índice. Se reinicia al cambiar de sección. */
class SectionBoundary extends Component<{ children: ReactNode; fallback: (retry: () => void, error: unknown) => ReactNode }, { error: unknown }> {
  state = { error: null as unknown }
  static getDerivedStateFromError(error: unknown) { return { error } }
  render() {
    if (this.state.error) return this.props.fallback(() => this.setState({ error: null }), this.state.error)
    return this.props.children
  }
}

export default function SettingsPage() {
  const { t } = useT("settings")
  const [params] = useSearchParams()
  const requested = params.get("section")
  const active: SectionId = isSection(requested) ? requested : "general"
  const Section = SECTIONS[active]
  return (
    <div className="page" style={{ maxWidth: PAGE_MAX_WIDTH }}>
      <div className="ph"><div className="ph-text"><h1 className="h1">{t("page.title")}</h1></div></div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-6)", alignItems: "flex-start" }}>
        <nav aria-label={t("page.sectionsLabel")} style={{ flex: `0 0 ${INDEX_WIDTH}px`, display: "flex", flexDirection: "column", gap: 2 }}>
          {SECTION_IDS.map(id => (
            <Link
              key={id}
              to={{ search: `?section=${id}` }}
              className={cx("nav-item", id === active && "is-active")}
              aria-current={id === active ? "page" : undefined}
            >
              {t(`sections.${id}`)}
            </Link>
          ))}
        </nav>
        <div style={{ flex: "999 1 480px", minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
          <SectionBoundary key={active} fallback={(retry, error) => <ErrorState error={error} title={t("page.loadFailed")} onRetry={retry} />}>
            <Suspense fallback={<SkeletonRows count={4} avatar={false} />}>
              <Section />
            </Suspense>
          </SectionBoundary>
        </div>
      </div>
    </div>
  )
}
