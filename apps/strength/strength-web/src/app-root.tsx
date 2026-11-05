import { type SmartAppPage, SmartAppRoot } from '@wildflowerhealthio/smart-app-react'
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
 * @param page - The page the app's router runs over, whose basepath is also
 *   the OAuth redirect target.
 * @param search - The query string the page arrived with; see `SmartAppRoot`.
 *   Defaults to the live URL's; tests pass one.
 */
function AppRoot({
  page,
  search,
}: {
  readonly page: SmartAppPage
  readonly search?: string
}): JSX.Element {
  return (
    <SmartAppRoot
      app="strength"
      registration={smartRegistration}
      telemetry={smartAppTelemetry}
      basepath={page.basepath}
      search={search}
    >
      <App page={page} />
    </SmartAppRoot>
  )
}

export { AppRoot }
