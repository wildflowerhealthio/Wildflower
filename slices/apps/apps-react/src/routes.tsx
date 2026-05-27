import { type AnyRoute, createRoute } from '@tanstack/react-router'

import { AppsHomeScreen } from './screens/apps-home-screen.tsx'

/**
 * Authorized routes contributed by the apps slice. Returned as a
 * `(parent) => Route[]` factory; the app attaches these under its
 * authorized-shell layout route. The apps client layer (provided once
 * at the app's top level via `<AppsClientProvider>`) reads the live
 * token from `BearerToken` — no per-route token plumbing.
 */
const appsAuthorizedRoutesFragment = (parent: AnyRoute): readonly AnyRoute[] => [
  createRoute({
    getParentRoute: () => parent,
    path: '/apps',
    component: AppsHomeScreen,
  }),
]

export { appsAuthorizedRoutesFragment }
