import { SmartAppRoot } from '@wildflowerhealthio/smart-app-react'
import type { JSX } from 'react'

import { App } from './app.tsx'
import { smartAppTelemetry, smartRegistration } from './config.ts'

/**
 * The hybrid seam for `fhir-sync-pebble-web`: the shared `SmartAppRoot` around
 * `App`. A bare visit is the SMART login (the landing page and `ConnectMenu`);
 * the OAuth callback is the Pebble settings page.
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
      app="fhirSyncPebble"
      registration={smartRegistration}
      telemetry={smartAppTelemetry}
      search={search}
    >
      <App />
    </SmartAppRoot>
  )
}

export { AppRoot }
