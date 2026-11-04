import { SmartAppRoot } from '@wildflowerhealthio/smart-app-react'
import type { JSX } from 'react'

import { App } from './app.tsx'
import { smartAppTelemetry, smartRegistration } from './config.ts'

/**
 * Plots' root: the shared `SmartAppRoot` around `App`.
 * `App` completes the SMART handshake and loads the patient's Observations and
 * MedicationRequests as queries on the shell's one `QueryClient`.
 *
 * Its telemetry goes to the app's own Sentry project (`smartAppTelemetry`),
 * and only once the visitor consents to it.
 *
 * @param search - The query string the page arrived with; see `SmartAppRoot`.
 *   Defaults to the live URL's; tests pass one.
 */
function AppRoot({ search }: { readonly search?: string }): JSX.Element {
  return (
    <SmartAppRoot
      app="plots"
      registration={smartRegistration}
      telemetry={smartAppTelemetry}
      search={search}
    >
      <App />
    </SmartAppRoot>
  )
}

export { AppRoot }
