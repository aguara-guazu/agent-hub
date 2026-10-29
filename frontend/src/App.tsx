import "./styles/fonts.css"
import "./styles/ah.css"
import type { ReactNode } from "react"
import { Outlet, Route, Routes, useSearchParams } from "react-router-dom"
import Layout from "./components/Layout"
import { BySearchParam, InterimHome, LegacyPage, Redirect } from "./components/RouteFallbacks"
import { Button } from "./components/ui/basics"
import { Empty, Loading } from "./components/ui/display"
import { ToastProvider } from "./components/ui/Toast"
import { uiText } from "./components/ui/strings"
import { AuthProvider, useAuth } from "./lib/auth"
import { useTheme } from "./lib/theme"
import { DeliveriesPage, DeliveryDetailPage, SchedulesPage } from "./pages/Automations"
import { HubActivity, HubCatalog, HubClients, HubSettings, HubSkills } from "./pages/Hub"
import { MemoryEntityPage, MemoryExplore, MemoryProjects, MemoryReview, MemorySearch } from "./pages/Memory"
import { MemoryLocalCollaboration } from "./pages/MemoryLocalCollaboration"
import { MemoryProcessing } from "./pages/MemoryProcessing"
import { MemorySettings } from "./pages/MemorySettings"

function LocalSession() {
  const { user, loading, reload } = useAuth()
  const theme = useTheme()
  if (user) return <Outlet />
  return (
    <div className={`ah shell ${theme.className}`} style={{ alignItems: "center", justifyContent: "center" }}>
      {loading
        ? <Loading label={uiText("session.connecting")} />
        : <Empty icon="brand" title={uiText("session.title")} detail={uiText("session.detail")} action={<Button variant="primary" onClick={() => void reload()}>{uiText("action.reload")}</Button>} />}
    </div>
  )
}

const legacy = (element: ReactNode) => <LegacyPage>{element}</LegacyPage>

/** Árbol de rutas del rediseño. Las rutas previas redirigen a su destino nuevo para no romper enlaces
 *  de notificaciones, del proceso de escritorio (`desktop/src/navigation.ts`) ni de la memoria. */
export function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          <Route element={<LocalSession />}>
            <Route element={<Layout />}>
              <Route index element={<Redirect to="/home" />} />
              <Route path="home" element={<InterimHome review={<MemoryReview />} />} />

              <Route path="projects" element={legacy(<MemoryProjects />)} />
              <Route path="projects/:id" element={legacy(<MemoryEntityPage />)} />
              <Route path="memory" element={legacy(<MemoryHome />)} />
              <Route path="memory/entities/:id" element={legacy(<MemoryEntityPage />)} />
              <Route path="collaboration" element={legacy(<MemoryLocalCollaboration />)} />
              <Route path="automations" element={legacy(<BySearchParam name="view" cases={{ history: <DeliveriesPage /> }} fallback={<SchedulesPage />} />)} />
              <Route path="automations/deliveries/:runId" element={legacy(<DeliveryDetailPage />)} />

              <Route path="servers" element={legacy(<HubCatalog />)} />
              <Route path="skills" element={legacy(<HubSkills />)} />
              <Route path="clients" element={legacy(<HubClients />)} />
              <Route path="activity" element={legacy(<BySearchParam name="tab" cases={{ procesamiento: <MemoryProcessing /> }} fallback={<HubActivity />} />)} />
              <Route path="settings" element={legacy(<BySearchParam name="section" cases={{ fuentes: <MemorySettings /> }} fallback={<HubSettings />} />)} />

              <Route path="catalog" element={<Redirect to="/servers" />} />
              <Route path="schedules" element={<Redirect to="/automations" />} />
              <Route path="deliveries" element={<Redirect to="/automations?view=history" />} />
              <Route path="deliveries/:runId" element={<Redirect to={params => `/automations/deliveries/${params.runId}`} />} />
              <Route path="memory/collaboration" element={<Redirect to="/collaboration" />} />
              <Route path="memory/search" element={<Redirect to="/memory" />} />
              <Route path="memory/review" element={<Redirect to="/home" />} />
              <Route path="memory/sources" element={<Redirect to="/settings?section=fuentes" keepSearch={false} />} />
              <Route path="memory/processing" element={<Redirect to="/activity?tab=procesamiento" keepSearch={false} />} />
              <Route path="memory/*" element={<Redirect to="/memory" keepSearch={false} />} />
              <Route path="machines" element={<Redirect to="/clients" keepSearch={false} />} />
              <Route path="audit" element={<Redirect to="/activity" keepSearch={false} />} />
              <Route path="*" element={<Redirect to="/home" keepSearch={false} />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </ToastProvider>
  )
}

/** Memoria provisoria: con `?q=` muestra la búsqueda existente; sin consulta, el explorador. */
function MemoryHome() {
  const [params] = useSearchParams()
  return params.get("q") ? <MemorySearch /> : <MemoryExplore />
}

export default App
