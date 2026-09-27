import type { JSX } from 'react'
import { SmartAppRoot } from 'smart-app-react'

import { App } from './app.tsx'
import { standaloneSmartConfig } from './config.ts'

/**
 * The hybrid seam for `fhir-sync-pebble-web`: the shared `SmartAppRoot` around
 * `App`. A bare visit is the SMART login (the landing page and `ConnectMenu`);
 * the OAuth callback is the Pebble settings page.
 *
 * @param launched - Whether the URL carries a SMART callback to complete; see
 *   `SmartAppRoot`. Defaults to the live URL check; tests pass it explicitly.
 */
function AppRoot({ launched }: { readonly launched?: boolean }): JSX.Element {
  return (
    <SmartAppRoot app="fhirSyncPebble" standalone={standaloneSmartConfig} launched={launched}>
      <App />
    </SmartAppRoot>
  )
}

export { AppRoot }
