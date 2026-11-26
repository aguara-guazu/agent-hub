import { lazy } from 'react'
const Inbox = lazy(() => import('./Inbox'))
export default {
  settings: lazy(() => import('./Settings')),
  routes: [
    { path: 'assistants', Component: Inbox },
    { path: 'assistants/:id', Component: Inbox },
  ],
}
