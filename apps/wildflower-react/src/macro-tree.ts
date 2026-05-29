import { createRootRoute, createRoute } from '@tanstack/react-router'
import * as apps from 'apps-react'
import * as collector from 'collector-react'
import * as gatekeeper from 'gatekeeper-react'
import * as tunnel from 'tunnel-react'

import { SettingsLayout } from './routes/settings.tsx'
import { SettingsIndex } from './routes/settings/index.tsx'
import { AuthorizedAppShell } from './session/authorized-app-shell.tsx'
import { RootShell } from './session/root-shell.tsx'

/**
 * App-level macro tree. Each slice exposes three arrays of route
 * factories (`openRoutes`, `authRoutes`, `settingsRoutes`). A factory
 * takes the app-provided parent and builds a fresh route under it, with
 * `route.useParams()` / `route.useSearch()` typed against the
 * slice-local URLs. Calling a factory here binds it to the app's
 * structural skeleton; calling it again elsewhere (a slice's test
 * router) yields an independent object, so no mutable singleton is
 * shared between trees.
 *
 *   - Open routes mount directly under root (no auth shell).
 *   - Authenticated routes mount under a pathless `_auth` layout that
 *     gates on a live bearer token via `AuthorizedAppShell`.
 *   - Settings routes mount under a pathless `_settings-wrapper`
 *     layout that contributes the persistent "Settings" header. The
 *     `/settings` URL prefix is baked into the slice's settings route
 *     literals, so the layout doesn't need a path of its own.
 */
const rootRoute = createRootRoute({ component: RootShell })

const authShellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_auth',
  component: AuthorizedAppShell,
})

const settingsLayoutRoute = createRoute({
  getParentRoute: () => authShellRoute,
  id: '_settings-wrapper',
  component: SettingsLayout,
})

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: '/settings',
  component: SettingsIndex,
})

const openFactories = [
  ...gatekeeper.openRoutes,
  ...apps.openRoutes,
  ...collector.openRoutes,
  ...tunnel.openRoutes,
]
const authFactories = [
  ...gatekeeper.authRoutes,
  ...apps.authRoutes,
  ...collector.authRoutes,
  ...tunnel.authRoutes,
]
const settingsFactories = [
  ...gatekeeper.settingsRoutes,
  ...apps.settingsRoutes,
  ...collector.settingsRoutes,
  ...tunnel.settingsRoutes,
]

const routeTree = rootRoute.addChildren([
  ...openFactories.map((make) => make(() => rootRoute)),
  authShellRoute.addChildren([
    ...authFactories.map((make) => make(() => authShellRoute)),
    settingsLayoutRoute.addChildren([
      settingsIndexRoute,
      ...settingsFactories.map((make) => make(() => settingsLayoutRoute)),
    ]),
  ]),
])

export { routeTree }
