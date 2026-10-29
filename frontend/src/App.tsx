import "./styles/fonts.css"
import "./styles/ah.css"
import { Outlet, Route, Routes } from "react-router-dom"
import Layout from "./components/Layout"
import { Redirect } from "./components/RouteFallbacks"
import { Button } from "./components/ui/basics"
import { Empty, Loading } from "./components/ui/display"
import { ToastProvider } from "./components/ui/Toast"
import { useT } from "./i18n"
import { AuthProvider, useAuth } from "./lib/auth"
import { useTheme } from "./lib/theme"
import AutomationsPage from "./pages/automations/AutomationsPage"
import MemoryPage from "./pages/memory/MemoryPage"
import MemoryEntityView from "./pages/memory/EntityPage"
import ProjectPage from "./pages/project/ProjectPage"
import ProjectsPage from "./pages/projects/ProjectsPage"
import CollaborationPage from "./pages/collaboration/CollaborationPage"
import ActivityPage from "./pages/activity/ActivityPage"
import SettingsPage from "./pages/settings/SettingsPage"
import SkillsPage from "./pages/skills/SkillsPage"
import ClientsPage from "./pages/clients/ClientsPage"
import ServersPage from "./pages/servers/ServersPage"
import HomePage from "./pages/home/HomePage"

function LocalSession() {
  const { user, loading, reload } = useAuth()
  const theme = useTheme()
  const { t } = useT("common")
  if (user) return <Outlet />
  return (
    <div className={`ah shell ${theme.className}`} style={{ alignItems: "center", justifyContent: "center" }}>
      {loading
        ? <Loading label={t("session.connecting")} />
        : <Empty icon="brand" title={t("session.title")} detail={t("session.detail")} action={<Button variant="primary" onClick={() => void reload()}>{t("actions.reconnect")}</Button>} />}
    </div>
  )
}


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
              <Route path="home" element={<HomePage />} />

              <Route path="projects" element={<ProjectsPage />} />
              <Route path="projects/:id" element={<ProjectPage />} />
              <Route path="memory" element={<MemoryPage />} />
              <Route path="memory/entities/:id" element={<MemoryEntityView />} />
              <Route path="collaboration" element={<CollaborationPage />} />
              <Route path="automations" element={<AutomationsPage />} />
              <Route path="automations/deliveries/:runId" element={<AutomationsPage />} />

              <Route path="servers" element={<ServersPage />} />
              <Route path="skills" element={<SkillsPage />} />
              <Route path="clients" element={<ClientsPage />} />
              <Route path="activity" element={<ActivityPage />} />
              <Route path="settings" element={<SettingsPage />} />

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

export default App
