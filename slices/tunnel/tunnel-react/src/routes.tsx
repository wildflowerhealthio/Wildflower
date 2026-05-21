import type { JSX } from 'react'
import { Route } from 'react-router'

import { TunnelScreen } from './screens/tunnel-screen.tsx'

// Exported as a JSX.Element (not a component): React Router's <Routes>
// walks children syntactically and rejects custom components with
// "[X] is not a <Route>". The path hardcodes `/settings/tunnel` so it
// matches without basename gymnastics under both MemoryRouter and
// BrowserRouter; the drift test in tests/routes.test.tsx asserts it.
//
// The tunnel screen is a settings surface — there is no public
// counterpart. `apps/wildflower-react` mounts this fragment alongside
// the other slices' `*SettingsRoutesFragment`s as children of
// `<Route element={<AuthorizedAppShell />}>`, which re-provides
// `<TunnelClientProvider>` with the live bearer token.

/**
 * Owner-facing tunnel settings routes — require a bearer token. The
 * app mounts these as children of its authenticated route element so
 * the shell can re-provide `<TunnelClientProvider>` with the live
 * token.
 */
const tunnelSettingsRoutesFragment: JSX.Element = (
  <>
    <Route path="/settings/tunnel" element={<TunnelScreen />} />
  </>
)

export { tunnelSettingsRoutesFragment }
