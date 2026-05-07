import { gatekeeperRoutesFragment } from 'gatekeeper-web'
import type { JSX } from 'react'

// Composed route fragment. Exported as a JSX.Element (not a component)
// because React Router's <Routes> walks its children syntactically and only
// recognizes <Route> elements and fragments — a custom component would throw
// "[X] is not a <Route> component". New slice routes plug in here as
// additional fragment children.
const appRoutesFragment: JSX.Element = <>{gatekeeperRoutesFragment}</>

export { appRoutesFragment }
