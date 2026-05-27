import { type AnyRoute, createRoute } from '@tanstack/react-router'

import { AccountConfigScreen } from './screens/account-config.tsx'
import { AccountListScreen } from './screens/account-list.tsx'

/**
 * Owner-facing collector routes contributed by the collector slice.
 * Returned as a `(parent) => Route[]` factory; the app attaches these
 * under its authorized-shell layout route alongside other slices'
 * authenticated-route fragments. The collector client layer (provided
 * once at the app's top level via `<CollectorClientProvider>`) reads
 * the live token from `BearerToken` — no per-route token plumbing.
 *
 * Collector is top-level functionality (not a settings concern), so its
 * routes live at `/collector/*` rather than under `/settings/`.
 */
const collectorAuthenticatedRoutesFragment = (parent: AnyRoute): readonly AnyRoute[] => [
  createRoute({
    getParentRoute: () => parent,
    path: '/collector',
    component: AccountListScreen,
  }),
  createRoute({
    getParentRoute: () => parent,
    path: '/collector/account/new',
    component: AccountConfigScreen,
  }),
  createRoute({
    getParentRoute: () => parent,
    path: '/collector/account/$id',
    component: AccountConfigScreen,
  }),
]

export { collectorAuthenticatedRoutesFragment }
