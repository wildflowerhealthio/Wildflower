import { appsAuthorizedRoutesFragment } from 'apps-react'
import { collectorAuthorizedRoutesFragment } from 'collector-react'
import {
  gatekeeperAuthorizedRoutesFragment,
  gatekeeperPublicRoutesFragment,
} from 'gatekeeper-react'
import type { JSX } from 'react'
import { Route } from 'react-router'
import { tunnelAuthorizedRoutesFragment } from 'tunnel-react'
import { AuthorizedAppShell } from './session/authorized-app-shell.tsx'

// Exported as JSX.Element (not a component): React Router's <Routes>
// walks its children syntactically and rejects custom components with
// "[X] is not a <Route>".
//
// Public routes mount alongside the shell; owner-facing routes live as
// children of a `<Route element={<AuthorizedAppShell />}>`. The shell
// gates rendering on a live bearer token but does not re-provide the
// slice client providers — each slice's layer reads the token from
// `BearerToken` per request, so a single tokenless provider mounted at
// the app root suffices.
const appRoutesFragment: JSX.Element = (
  <>
    {gatekeeperPublicRoutesFragment}
    <Route element={<AuthorizedAppShell />}>
      {gatekeeperAuthorizedRoutesFragment}
      {collectorAuthorizedRoutesFragment}
      {appsAuthorizedRoutesFragment}
      {tunnelAuthorizedRoutesFragment}
    </Route>
  </>
)

export { appRoutesFragment }
