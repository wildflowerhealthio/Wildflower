import type { JSX } from 'react'
import { SmartAppRoot } from 'smart-app-react'

import { App } from './app.tsx'
import { standaloneSmartConfig } from './config.ts'

/**
 * The hybrid seam for `wildflower-lifting`: the shared `SmartAppRoot` around
 * `App`. `App` completes the SMART handshake as a query on the shell's one
 * `QueryClient`, then reads the plan and its sessions and writes through that
 * same client, so the exchange and every read/write share one cache.
 *
 * @param launched - Whether the URL carries a SMART callback to complete; see
 *   `SmartAppRoot`. Defaults to the live URL check; tests pass it explicitly.
 */
function AppRoot({ launched }: { readonly launched?: boolean }): JSX.Element {
  return (
    <SmartAppRoot app="lifting" standalone={standaloneSmartConfig} launched={launched}>
      <App />
    </SmartAppRoot>
  )
}

export { AppRoot }
