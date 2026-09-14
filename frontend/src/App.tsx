import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { LoadingBlock } from './components/Spinner'
import { ToastProvider } from './components/Toast'
import { AuthProvider, useAuth } from './lib/auth'
import { HubActivity, HubCatalog, HubClients, HubSettings, HubSkills } from './pages/Hub'
import { MemoryProjects, MemoryExplore, MemoryEntityPage, MemorySearch, MemoryReview } from './pages/Memory'
import { MemorySettings } from './pages/MemorySettings'
import { MemoryProcessing } from './pages/MemoryProcessing'

function LocalSession() {
  const { user, loading, reload } = useAuth()
  if (loading) return <LoadingBlock full label="Conectando con tu hub…" />
  if (!user) return <div className="hub-session"><div className="hub-session-mark">⌘</div><h1>Agent Hub</h1><p>Abrí la aplicación de escritorio para conectar con tu catálogo local.</p><button className="btn btn-primary" onClick={() => void reload()}>Volver a conectar</button></div>
  return <Outlet />
}

export function App() {
  return <ToastProvider><AuthProvider><Routes><Route element={<LocalSession />}><Route element={<Layout />}>
    <Route index element={<Navigate to="/catalog" replace />} />
    <Route path="catalog" element={<HubCatalog />} />
    <Route path="skills" element={<HubSkills />} />
    <Route path="clients" element={<HubClients />} />
    <Route path="activity" element={<HubActivity />} />
    <Route path="settings" element={<HubSettings />} />
    <Route path="projects" element={<MemoryProjects />} />
    <Route path="projects/:id" element={<MemoryEntityPage />} />
    <Route path="memory" element={<MemoryExplore />} />
    <Route path="memory/entities/:id" element={<MemoryEntityPage />} />
    <Route path="memory/search" element={<MemorySearch />} />
    <Route path="memory/review" element={<MemoryReview />} />
    <Route path="memory/sources" element={<MemorySettings />} />
    <Route path="memory/processing" element={<MemoryProcessing />} />
    <Route path="machines" element={<Navigate to="/clients" replace />} />
    <Route path="audit" element={<Navigate to="/activity" replace />} />
    <Route path="*" element={<Navigate to="/catalog" replace />} />
  </Route></Route></Routes></AuthProvider></ToastProvider>
}
export default App
