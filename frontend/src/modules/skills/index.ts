import { lazy } from 'react'
const SkillsPage = lazy(() => import('./catalog/SkillsPage'))

export default {
  settings: lazy(() => import('./Settings')),
  routes: [
    { path: 'skills', Component: SkillsPage },
  ],
}
