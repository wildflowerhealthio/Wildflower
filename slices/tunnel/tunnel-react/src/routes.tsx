import type { JSX } from 'react'
import { Route } from 'react-router'

import { TunnelScreen } from './screens/tunnel-screen.tsx'

// Exported as a JSX.Element (not a component): React Router's <Routes>
// walks children syntactically and rejects custom components with
// "[X] is not a <Route>". The path hardcodes the `/tunnel` prefix so it
// matches without basename gymnastics under both MemoryRouter and
// BrowserRouter; the drift test in tests/routes.test.tsx asserts it.
//
// The tunnel API is owner-only — there is no public counterpart — so a
// single authorized fragment is the entire surface. The composing app
// must mount this inside a `<Route element={<AuthorizedAppShell />}>`
// (or whatever shell re-provides `<TunnelClientProvider>` with the live
// bearer token).

/**
 * Owner-facing tunnel routes — require a bearer token. The app mounts
 * these as children of its authenticated route element so the shell
 * can re-provide `<TunnelClientProvider>` with the live token.
 */
const tunnelAuthorizedRoutesFragment: JSX.Element = (
  <>
    <Route path="/tunnel" element={<TunnelScreen />} />
  </>
)

export { tunnelAuthorizedRoutesFragment }
