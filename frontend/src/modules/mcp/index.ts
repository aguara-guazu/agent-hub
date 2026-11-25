import { lazy } from 'react'
const ServersPage = lazy(() => import('./servers/ServersPage'))

export default {
  settings: lazy(() => import('./Settings')),
  routes: [
    { path: 'servers', Component: ServersPage },
  ],
}
