import { createRootRoute, createRoute } from '@tanstack/react-router'
import * as apps from 'apps-react'
import * as collector from 'collector-react'
import * as gatekeeper from 'gatekeeper-react'
import * as tunnel from 'tunnel-react'

import { SettingsIndex } from './routes/settings/index.tsx'
import { SettingsLayout } from './routes/settings.tsx'
import { AuthorizedAppShell } from './session/authorized-app-shell.tsx'
import { RootShell } from './session/root-shell.tsx'

/**
 * App-level macro tree. Each slice exposes three arrays of typed routes
 * (`openSubtree`, `authSubtree`, `settingsSubtree`); the slice's own
 * file-based plugin invocation generates them with `Route.useParams()`
 * / `Route.useSearch()` typed against the slice-local URLs. Here we
 * union them under the app's structural skeleton:
 *
 *   - Open routes mount directly under root (no auth shell).
 *   - Authenticated routes mount under a pathless `_auth` layout that
 *     gates on a live bearer token via `AuthorizedAppShell`.
 *   - Settings routes mount under a pathless `_settings-wrapper`
 *     layout that contributes the persistent "Settings" header. The
 *     `/settings` URL prefix is baked into the slice's settings route
 *     literals (the slice mounts its `_settings/` directory at
 *     `/settings`), so the layout doesn't need a path of its own.
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

const routeTree = rootRoute.addChildren([
  ...gatekeeper.openSubtree,
  ...apps.openSubtree,
  ...collector.openSubtree,
  ...tunnel.openSubtree,
  authShellRoute.addChildren([
    ...gatekeeper.authSubtree,
    ...apps.authSubtree,
    ...collector.authSubtree,
    ...tunnel.authSubtree,
    settingsLayoutRoute.addChildren([
      settingsIndexRoute,
      ...gatekeeper.settingsSubtree,
      ...apps.settingsSubtree,
      ...collector.settingsSubtree,
      ...tunnel.settingsSubtree,
    ]),
  ]),
])

export { routeTree }
