import type { JSX } from 'react'
import { SmartAppRoot } from 'smart-app-react'

import { App } from './app.tsx'
import { smartAppTelemetry, standaloneSmartConfig } from './config.ts'

/**
 * The Synthetic Data Loader's root: the shared `SmartAppRoot` around `App`.
 * `App` completes the SMART handshake as a query on the shell's one
 * `QueryClient`, then hands that same instance to its router context.
 *
 * Nothing mounts until the visitor answers the shell's telemetry consent
 * dialog, and the app's telemetry goes to its own Sentry project
 * (`smartAppTelemetry`) only once they say yes.
 *
 * @param launched - Whether the URL carries a SMART callback to complete; see
 *   `SmartAppRoot`. Defaults to the live URL check; tests pass it explicitly.
 */
function AppRoot({ launched }: { readonly launched?: boolean }): JSX.Element {
  return (
    <SmartAppRoot
      app="syntheticData"
      standalone={standaloneSmartConfig}
      telemetry={smartAppTelemetry}
      launched={launched}
    >
      <App />
    </SmartAppRoot>
  )
}

export { AppRoot }
