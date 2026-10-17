import type { RouterHistory } from '@tanstack/react-router'
import { SmartAppRoot } from '@wildflowerhealthio/smart-app-react'
import type { JSX } from 'react'

import { App } from './app.tsx'
import { smartAppTelemetry, smartRegistration } from './config.ts'

/**
 * The hybrid seam for `importer-web`: the shared `SmartAppRoot` around
 * `App`. `App` completes the SMART handshake as a query on the shell's one
 * `QueryClient`, then hands that same instance to its router context, so the
 * exchange and every app read/write share one cache.
 *
 * Its telemetry goes to the app's own Sentry project (`smartAppTelemetry`),
 * and only once the visitor consents to it.
 *
 * @param basepath - The served directory, the app's router's basepath.
 * @param history - The window's history, which the app's router navigates.
 * @param launched - Whether the URL carries a SMART callback to complete; see
 *   `SmartAppRoot`. Defaults to the live URL check; tests pass it explicitly.
 */
function AppRoot({
  basepath,
  history,
  launched,
}: {
  readonly basepath: string
  readonly history: RouterHistory
  readonly launched?: boolean
}): JSX.Element {
  return (
    <SmartAppRoot
      app="importer"
      registration={smartRegistration}
      telemetry={smartAppTelemetry}
      launched={launched}
    >
      <App basepath={basepath} history={history} />
    </SmartAppRoot>
  )
}

export { AppRoot }
