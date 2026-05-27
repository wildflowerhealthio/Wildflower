import { type AnyRoute, createRoute } from '@tanstack/react-router'

import { AccessIndexScreen } from './screens/access-index.tsx'
import { ApprovedAppDetailScreen } from './screens/approved-app-detail.tsx'
import { DeviceConsentScreen } from './screens/device-consent.tsx'
import { DeviceEntryScreen } from './screens/device-entry.tsx'
import { OAuthConsentScreen } from './screens/oauth-consent/index.tsx'
import { OAuthPollingScreen } from './screens/oauth-polling.tsx'
import { RequestDetailScreen } from './screens/request-detail.tsx'
import { RequestsListScreen } from './screens/requests-list.tsx'

// Each fragment is a `(parent) => Route[]` factory so the app can attach
// the slice's routes under a chosen parent (root, or an authorized layout
// route). Paths hardcode the `/gatekeeper/...` or `/settings/gatekeeper/...`
// prefix so they match without basename gymnastics under both
// `createBrowserHistory()` and `createMemoryHistory()`; the drift test in
// tests/routes.test.tsx asserts each redirect target has a matching route.
//
// Three fragments, three intents:
//   - Open routes: no bearer required (OAuth device-polling + the
//     unauthed device-entry form). Paths are externally published via
//     `GatekeeperPaths` and so MUST stay at `/gatekeeper/*`.
//   - Authenticated routes: require a bearer and are deep-linked from
//     the OAuth / RFC 8628 device flow (`oauth-consent/$id`,
//     `devices/$userCode`). Their paths are also externally published
//     and MUST stay at `/gatekeeper/*`.
//   - Settings routes: owner-facing landings for managing access
//     (index, request list/detail, approved-app detail). These live
//     under `/settings/gatekeeper/*` alongside the other slices' settings
//     fragments.

/** Open routes — no bearer token required. */
const gatekeeperOpenRoutesFragment = (parent: AnyRoute): readonly AnyRoute[] => [
  createRoute({
    getParentRoute: () => parent,
    path: '/gatekeeper/oauth-polling/$id',
    component: OAuthPollingScreen,
  }),
  createRoute({
    getParentRoute: () => parent,
    path: '/gatekeeper/devices',
    component: DeviceEntryScreen,
  }),
]

/**
 * Authenticated routes — require a bearer token. Deep-linked from the
 * OAuth + RFC 8628 device flows; the paths are published via
 * `GatekeeperPaths` so external clients can target them and must not
 * move.
 */
const gatekeeperAuthenticatedRoutesFragment = (parent: AnyRoute): readonly AnyRoute[] => [
  createRoute({
    getParentRoute: () => parent,
    path: '/gatekeeper/oauth-consent/$id',
    component: OAuthConsentScreen,
  }),
  createRoute({
    getParentRoute: () => parent,
    path: '/gatekeeper/devices/$userCode',
    component: DeviceConsentScreen,
  }),
]

/**
 * Owner-facing settings routes — require a bearer token. Mounted by
 * the app under its authorized-shell layout route alongside the other
 * slices' settings fragments. The unified `/settings` screen links to
 * `/settings/gatekeeper` via `gatekeeperSettingsItemsFragment`.
 */
const gatekeeperSettingsRoutesFragment = (parent: AnyRoute): readonly AnyRoute[] => [
  createRoute({
    getParentRoute: () => parent,
    path: '/settings/gatekeeper',
    component: AccessIndexScreen,
  }),
  createRoute({
    getParentRoute: () => parent,
    path: '/settings/gatekeeper/requests',
    component: RequestsListScreen,
  }),
  createRoute({
    getParentRoute: () => parent,
    path: '/settings/gatekeeper/requests/$id',
    component: RequestDetailScreen,
  }),
  createRoute({
    getParentRoute: () => parent,
    path: '/settings/gatekeeper/approved/$id',
    component: ApprovedAppDetailScreen,
  }),
]

export {
  gatekeeperOpenRoutesFragment,
  gatekeeperAuthenticatedRoutesFragment,
  gatekeeperSettingsRoutesFragment,
}
