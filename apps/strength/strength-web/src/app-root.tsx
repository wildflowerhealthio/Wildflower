import { SmartAppRoot } from '@wildflowerhealthio/smart-app-react'
import type { JSX } from 'react'

import { App } from './app.tsx'
import { smartAppTelemetry, smartRegistration } from './config.ts'

/**
 * Strength's root: the shared `SmartAppRoot` around `App`. `App`
 * completes the SMART handshake, reads the lifter's program, workouts and sets
 * as queries on the shell's one `QueryClient`, and writes what they submit.
 *
 * Its telemetry goes to the app's own Sentry project (`smartAppTelemetry`),
 * and only once the visitor consents to it.
 *
 * @param basepath - The served directory, the app's router's basepath.
 * @param launched - Whether the URL carries a SMART callback to complete; see
 *   `SmartAppRoot`. Defaults to the live URL check; tests pass it explicitly.
 */
function AppRoot({
  basepath,
  launched,
}: {
  readonly basepath: string
  readonly launched?: boolean
}): JSX.Element {
  return (
    <SmartAppRoot
      app="strength"
      registration={smartRegistration}
      telemetry={smartAppTelemetry}
      launched={launched}
    >
      <App basepath={basepath} />
    </SmartAppRoot>
  )
}

export { AppRoot }
