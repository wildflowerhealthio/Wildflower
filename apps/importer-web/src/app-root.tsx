import { QueryClientProvider } from '@tanstack/react-query'
import { BrandBar, fromApp, SiteFooter, SiteHeader } from 'branding-react'
import { ConnectMenu } from 'fhir-r4-react/connect'
import { buildSmartQueryClient, shouldCompleteSmartLaunch } from 'fhir-r4-react/smart'
import { useState, type JSX } from 'react'

import { App } from './app.tsx'
import { standaloneSmartConfig } from './config.ts'

/**
 * The app root is both the OAuth redirect target and the standalone landing
 * page. A callback in the URL (`code`/`state`, no `error`) means there is a
 * handshake to complete, so render `App`; otherwise show the connect menu.
 * `ConnectMenu`'s redirect target is this same root, derived from the current
 * URL so it works at whatever subdomain / path the bundle is served from.
 */
const redirectUri = new URL('.', window.location.href).href

/**
 * The hybrid seam for `wildflower-importer`: wraps both the EHR-launched
 * importer and the standalone connect menu in shared Wildflower chrome.
 *
 * @param launched - Whether a SMART handshake is in progress. Defaults to
 *   reading `shouldCompleteSmartLaunch()` from the current URL; pass
 *   explicitly in tests to exercise both branches without URL games.
 */
function AppRoot({
  launched = shouldCompleteSmartLaunch(),
}: {
  readonly launched?: boolean
}): JSX.Element {
  // One QueryClient for the whole page: `App` completes the SMART handshake as a
  // query on it (via `useSmartHandshake`), then hands this same instance to its
  // router context, so the exchange and every app read/write share one cache.
  const [queryClient] = useState(() => buildSmartQueryClient())

  return (
    <QueryClientProvider client={queryClient}>
      {launched ? (
        <>
          <BrandBar />
          <App />
        </>
      ) : (
        <>
          <SiteHeader nav={fromApp} />
          <main>
            <ConnectMenu
              clientId={standaloneSmartConfig.clientId}
              scope={standaloneSmartConfig.scope}
              redirectUri={redirectUri}
            />
          </main>
          <SiteFooter nav={fromApp} />
        </>
      )}
    </QueryClientProvider>
  )
}

export { AppRoot }
