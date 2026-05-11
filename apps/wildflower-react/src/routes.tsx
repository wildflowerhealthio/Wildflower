import {
  gatekeeperAuthorizedRoutesFragment,
  gatekeeperPublicRoutesFragment,
} from 'gatekeeper-react'
import type { JSX } from 'react'
import { Route } from 'react-router'
import { AuthorizedAppShell } from './session/authorized-app-shell.tsx'

// Exported as JSX.Element (not a component): React Router's <Routes>
// walks its children syntactically and rejects custom components with
// "[X] is not a <Route>".
//
// Public routes mount alongside the shell; owner-facing routes live as
// children of a `<Route element={<AuthorizedAppShell />}>` so the shell
// can re-provide the gatekeeper client with the live bearer token and
// (in later PRs) layer in per-slice client providers.
const appRoutesFragment: JSX.Element = (
  <>
    {gatekeeperPublicRoutesFragment}
    <Route element={<AuthorizedAppShell />}>{gatekeeperAuthorizedRoutesFragment}</Route>
  </>
)

export { appRoutesFragment }
