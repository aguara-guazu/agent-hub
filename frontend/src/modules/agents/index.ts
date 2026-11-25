import { lazy } from 'react'
const ClientsPage = lazy(() => import('./clients/ClientsPage'))

export default {
  settings: lazy(() => import('./Settings')),
  routes: [
    { path: 'clients', Component: ClientsPage },
  ],
}
