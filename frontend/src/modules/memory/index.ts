import { lazy } from 'react'
const ProjectsPage = lazy(() => import('./projects/ProjectsPage'))
const ProjectPage = lazy(() => import('./project/ProjectPage'))
const MemoryPage = lazy(() => import('./library/MemoryPage'))
const EntityPage = lazy(() => import('./library/EntityPage'))

export default {
  settings: lazy(() => import('./Settings')),
  routes: [
    { path: 'projects', Component: ProjectsPage },
    { path: 'projects/:id', Component: ProjectPage },
    { path: 'memory', Component: MemoryPage },
    { path: 'memory/entities/:id', Component: EntityPage },
  ],
}
