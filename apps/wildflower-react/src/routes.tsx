import { createRootRoute, createRoute, type AnyRoute } from '@tanstack/react-router'
import { appsAuthorizedRoutesFragment } from 'apps-react'
import { collectorAuthenticatedRoutesFragment } from 'collector-react'
import {
  gatekeeperAuthenticatedRoutesFragment,
  gatekeeperOpenRoutesFragment,
  gatekeeperSettingsRoutesFragment,
} from 'gatekeeper-react'
import { tunnelSettingsRoutesFragment } from 'tunnel-react'

import { SettingsScreen } from './screens/settings-screen.tsx'
import { AuthorizedAppShell } from './session/authorized-app-shell.tsx'
import { RootShell } from './session/root-shell.tsx'

// Programmatic route tree (TanStack Router code-based routing):
//   - The root route renders the entire provider stack via `<RootShell>`
//     and uses its `<Outlet />` to mount matched child routes.
//   - Open routes mount directly under root; owner-facing routes mount
//     under a layout route (`_auth`) whose component is `<AuthorizedAppShell>`.
//     The shell gates rendering on a live bearer token but does not
//     re-provide the slice client providers — each slice's layer reads the
//     token from `BearerToken` per request, so a single tokenless provider
//     mounted at the root suffices.
//   - Settings surface (issue #47): each participating slice exports a
//     `*SettingsRoutesFragment` factory (paths under `/settings/<slice>/…`)
//     and a `*SettingsItemsFragment` (menu entries). This file attaches
//     the route factories alongside `/settings` itself under the authorized
//     layout route; the screen concatenates the items fragments.
const rootRoute = createRootRoute({ component: RootShell })

const authShellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_auth',
  component: AuthorizedAppShell,
}) satisfies AnyRoute

const settingsIndexRoute = createRoute({
  getParentRoute: () => authShellRoute,
  path: '/settings',
  component: SettingsScreen,
})

const routeTree = rootRoute.addChildren([
  ...gatekeeperOpenRoutesFragment(rootRoute),
  authShellRoute.addChildren([
    ...gatekeeperAuthenticatedRoutesFragment(authShellRoute),
    ...appsAuthorizedRoutesFragment(authShellRoute),
    ...collectorAuthenticatedRoutesFragment(authShellRoute),
    settingsIndexRoute,
    ...tunnelSettingsRoutesFragment(authShellRoute),
    ...gatekeeperSettingsRoutesFragment(authShellRoute),
  ]),
])

export { routeTree }
