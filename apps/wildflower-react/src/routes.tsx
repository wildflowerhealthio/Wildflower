import { appsAuthorizedRoutesFragment } from 'apps-react'
import { collectorAuthenticatedRoutesFragment } from 'collector-react'
import {
  gatekeeperAuthenticatedRoutesFragment,
  gatekeeperOpenRoutesFragment,
  gatekeeperSettingsRoutesFragment,
} from 'gatekeeper-react'
import type { JSX } from 'react'
import { Route } from 'react-router'
import { tunnelSettingsRoutesFragment } from 'tunnel-react'
import { SettingsScreen } from './screens/settings-screen.tsx'
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
//
// Settings surface (issue #47): each participating slice exports a
// `*SettingsRoutesFragment` (paths under `/settings/<slice>/…`) and a
// `*SettingsItemsFragment` (menu entries). This file mounts the route
// fragments as siblings alongside `<SettingsScreen />` at `/settings`;
// the screen itself concatenates the items fragments.
const appRoutesFragment: JSX.Element = (
  <>
    {gatekeeperOpenRoutesFragment}
    <Route element={<AuthorizedAppShell />}>
      {gatekeeperAuthenticatedRoutesFragment}
      {appsAuthorizedRoutesFragment}
      {collectorAuthenticatedRoutesFragment}
      <Route path="/settings" element={<SettingsScreen />} />
      {tunnelSettingsRoutesFragment}
      {gatekeeperSettingsRoutesFragment}
    </Route>
  </>
)

export { appRoutesFragment }
