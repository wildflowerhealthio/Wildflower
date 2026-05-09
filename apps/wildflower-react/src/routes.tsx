import { gatekeeperRoutesFragment } from 'gatekeeper-react'
import type { JSX } from 'react'

// Exported as JSX.Element (not a component): React Router's <Routes> walks its
// children syntactically and rejects custom components with "[X] is not a <Route>".
const appRoutesFragment: JSX.Element = <>{gatekeeperRoutesFragment}</>

export { appRoutesFragment }
