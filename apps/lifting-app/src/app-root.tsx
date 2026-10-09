import type { JSX } from 'react'
import { SmartAppRoot } from 'smart-app-react'

import { App } from './app.tsx'
import { smartAppTelemetry, smartRegistration } from './config.ts'

/**
 * The lifting app's root: the shared `SmartAppRoot` around `App`. `App`
 * completes the SMART handshake, reads the lifter's program, workouts and sets
 * as queries on the shell's one `QueryClient`, and writes what they submit.
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
      app="lifting"
      registration={smartRegistration}
      telemetry={smartAppTelemetry}
      launched={launched}
    >
      <App />
    </SmartAppRoot>
  )
}

export { AppRoot }
