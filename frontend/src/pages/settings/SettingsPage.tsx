import { moduleViews } from '../../modules/catalog'
import { appModules, isModuleId, type ModuleId } from '@agenthub/shared/modules'
import { ModuleSettings } from '../../modules/ModuleSettings'
import { Component, Suspense, lazy } from "react"
import type { ReactNode } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ErrorState, SkeletonRows, cx } from "../../components/ui"
import { useT } from "../../i18n"

type SectionId = 'general' | 'sistema' | ModuleId
export const SECTION_IDS: readonly SectionId[] = ['general', ...appModules.map(module => module.id), 'sistema']

const legacy: Record<string, ModuleId> = {
  fuentes: 'connections', integraciones: 'connections', ia: 'memory', respaldos: 'memory',
  colaboracion: 'agents', automatizaciones: 'schedules',
}
const general = lazy(() => import('./sections/General'))
const system = lazy(() => import('./sections/Sistema'))

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
  const active: SectionId = requested === 'sistema' || (requested && isModuleId(requested)) ? requested
    : requested && Object.hasOwn(legacy, requested) ? legacy[requested] : 'general'
  const Section = isModuleId(active) ? moduleViews[active].settings : active === 'general' ? general : system
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
              {isModuleId(active) ? <ModuleSettings key={active} id={active}><Section /></ModuleSettings> : <Section />}
            </Suspense>
          </SectionBoundary>
        </div>
      </div>
    </div>
  )
}
