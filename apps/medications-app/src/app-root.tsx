import { SmartAppRoot } from 'fhir-r4-react/app-shell'
import type { JSX } from 'react'

import { App } from './app.tsx'
import { standaloneSmartConfig } from './config.ts'

/**
 * The Medication Viewer's root: the shared `SmartAppRoot` around `App`. `App`
 * completes the SMART handshake and loads the MedicationRequests as queries on
 * the shell's one `QueryClient`.
 *
 * @param launched - Whether the URL carries a SMART callback to complete; see
 *   `SmartAppRoot`. Defaults to the live URL check; tests pass it explicitly.
 */
function AppRoot({ launched }: { readonly launched?: boolean }): JSX.Element {
  return (
    <SmartAppRoot app="medications" standalone={standaloneSmartConfig} launched={launched}>
      <App />
    </SmartAppRoot>
  )
}

export { AppRoot }
