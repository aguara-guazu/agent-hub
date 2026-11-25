import { lazy } from 'react'
const AutomationsPage = lazy(() => import('./jobs/AutomationsPage'))

export default {
  settings: lazy(() => import('./Automatizaciones')),
  routes: [
    { path: 'automations', Component: AutomationsPage },
    { path: 'automations/deliveries/:runId', Component: AutomationsPage },
  ],
}
