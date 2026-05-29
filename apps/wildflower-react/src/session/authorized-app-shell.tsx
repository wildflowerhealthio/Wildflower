import { Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'

import { RequireAuth } from './require-auth.tsx'

/**
 * Outlet wrapper for the pathless `_auth` layout. Gates owner-facing
 * routes on a live bearer token via `RequireAuth`, rendering the matched
 * child route through `<Outlet>` once authenticated.
 */
const AuthorizedAppShell = (): JSX.Element => (
  <RequireAuth>
    <Outlet />
  </RequireAuth>
)

export { AuthorizedAppShell }
