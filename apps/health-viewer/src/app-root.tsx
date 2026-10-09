import type { JSX } from 'react'
import { SmartAppRoot } from 'smart-app-react'

import { App } from './app.tsx'
import { smartAppTelemetry, smartRegistration } from './config.ts'

/**
 * The Synthesized Health Viewer's root: the shared `SmartAppRoot` around `App`.
 * `App` completes the SMART handshake and loads the patient's Observations and
 * MedicationRequests as queries on the shell's one `QueryClient`.
 *
 * Its telemetry goes to the app's own Sentry project (`smartAppTelemetry`),
 * and only once the visitor consents to it.
 *
 * @param launched - Whether the URL carries a SMART callback to complete; see
 *   `SmartAppRoot`. Defaults to the live URL check; tests pass it explicitly.
 */
function AppRoot({ launched }: { readonly launched?: boolean }): JSX.Element {
  return (
    <SmartAppRoot
      app="healthViewer"
      registration={smartRegistration}
      telemetry={smartAppTelemetry}
      launched={launched}
    >
      <App />
    </SmartAppRoot>
  )
}

export { AppRoot }
