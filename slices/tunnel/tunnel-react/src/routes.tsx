import { type AnyRoute, createRoute } from '@tanstack/react-router'

import { TunnelScreen } from './screens/tunnel-screen.tsx'

// Returned as a `(parent) => Route[]` factory so the app can attach
// these under its authorized-shell layout route alongside the other
// slices' settings fragments. The path hardcodes `/settings/tunnel` so
// it matches without basename gymnastics under both
// `createBrowserHistory` and `createMemoryHistory`; the drift test in
// tests/routes.test.tsx asserts it.
//
// The tunnel screen is a settings surface — there is no public
// counterpart. `apps/wildflower-react` attaches this fragment alongside
// the other slices' settings fragments under the authorized-shell
// layout, which re-provides `<TunnelClientProvider>` with the live
// bearer token.

/**
 * Owner-facing tunnel settings routes — require a bearer token. The
 * app attaches these under its authorized-shell layout route so the
 * shell can re-provide `<TunnelClientProvider>` with the live token.
 */
const tunnelSettingsRoutesFragment = (parent: AnyRoute): readonly AnyRoute[] => [
  createRoute({
    getParentRoute: () => parent,
    path: '/settings/tunnel',
    component: TunnelScreen,
  }),
]

export { tunnelSettingsRoutesFragment }
