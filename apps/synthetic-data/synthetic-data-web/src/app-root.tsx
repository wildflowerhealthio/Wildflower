import { SmartAppRoot } from '@wildflowerhealthio/smart-app-react'
import type { JSX } from 'react'

import { App } from './app.tsx'
import { smartAppTelemetry, smartRegistration } from './config.ts'

/**
 * The Synthetic Data Loader's root: the shared `SmartAppRoot` around `App`.
 * `App` completes the SMART handshake as a query on the shell's one
 * `QueryClient`, then hands that same instance to its router context.
 *
 * Nothing mounts until the visitor answers the shell's telemetry consent
 * dialog, and the app's telemetry goes to its own Sentry project
 * (`smartAppTelemetry`) only once they say yes.
 *
 * @param search - The query string the page arrived with; see `SmartAppRoot`.
 *   Defaults to the live URL's; tests pass one.
 */
function AppRoot({ search }: { readonly search?: string }): JSX.Element {
  return (
    <SmartAppRoot
      app="syntheticData"
      registration={smartRegistration}
      telemetry={smartAppTelemetry}
      search={search}
    >
      <App />
    </SmartAppRoot>
  )
}

export { AppRoot }
