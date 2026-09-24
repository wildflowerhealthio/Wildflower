import type { JSX } from 'react'
import { SmartAppRoot } from 'smart-app-react'

import { App } from './app.tsx'
import { standaloneSmartConfig } from './config.ts'

/**
 * The hybrid seam for `wildflower-importer`: the shared `SmartAppRoot` around
 * `App`. `App` completes the SMART handshake as a query on the shell's one
 * `QueryClient`, then hands that same instance to its router context, so the
 * exchange and every app read/write share one cache.
 *
 * @param launched - Whether the URL carries a SMART callback to complete; see
 *   `SmartAppRoot`. Defaults to the live URL check; tests pass it explicitly.
 */
function AppRoot({ launched }: { readonly launched?: boolean }): JSX.Element {
  return (
    <SmartAppRoot app="importer" standalone={standaloneSmartConfig} launched={launched}>
      <App />
    </SmartAppRoot>
  )
}

export { AppRoot }
