import { QueryClientProvider } from '@tanstack/react-query'
import { BrandBar, SiteFooter, SiteHeader, fromApp } from 'branding-react'
import { ConnectMenu } from 'fhir-r4-react/connect'
import { buildSmartQueryClient, shouldCompleteSmartLaunch } from 'fhir-r4-react/smart'
import type { JSX } from 'react'
import { useState } from 'react'

import { App } from './app.tsx'
import { standaloneSmartConfig } from './config.ts'
import styles from './app.module.css'

// `ConnectMenu`'s redirect target is this same root, derived from the current
// URL so it works at whatever subdomain the self-hosted bundle is served from.
const redirectUri = new URL('.', window.location.href).href

/**
 * Top-level app shell: wraps the two branches (SMART-launched app, standalone
 * connect menu) in shared Wildflower chrome and one `QueryClientProvider`.
 *
 * @param launched - Whether the URL carries a SMART callback to complete: the
 *   launched branch renders `BrandBar` over `App`; the standalone branch renders
 *   the full `SiteHeader` / `ConnectMenu` / `SiteFooter` page. Defaults to the
 *   live URL check (`shouldCompleteSmartLaunch`); tests pass it explicitly.
 */
function AppRoot({
  launched = shouldCompleteSmartLaunch(),
}: {
  readonly launched?: boolean
}): JSX.Element {
  // One QueryClient for the whole page: `App` completes the SMART handshake and
  // loads the MedicationRequests as queries on it (via `useSmartHandshake`), so
  // both share one cache and the single-use code is exchanged exactly once even
  // under StrictMode's double-mount.
  const [queryClient] = useState(() => buildSmartQueryClient())

  return (
    <QueryClientProvider client={queryClient}>
      {launched ? (
        <>
          <BrandBar />
          <App />
        </>
      ) : (
        <div className={styles['standalone-page']}>
          <SiteHeader nav={fromApp} />
          <main className={styles['connect-page']}>
            <ConnectMenu
              clientId={standaloneSmartConfig.clientId}
              scope={standaloneSmartConfig.scope}
              redirectUri={redirectUri}
            />
          </main>
          <SiteFooter nav={fromApp} />
        </div>
      )}
    </QueryClientProvider>
  )
}

export { AppRoot }
