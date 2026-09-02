import { QueryClientProvider } from '@tanstack/react-query'
import { BrandBar, SiteFooter, SiteHeader, fromApp } from 'branding-react'
import { ConnectMenu } from 'fhir-r4-react/connect'
import { buildSmartQueryClient, shouldCompleteSmartLaunch } from 'fhir-r4-react/smart'
import { useState, type JSX } from 'react'

import { App } from './app.tsx'
import { standaloneSmartConfig } from './config.ts'

// `ConnectMenu`'s redirect target is this same root, derived from the current
// URL so it works at whatever subdomain the self-hosted bundle is served from.
const redirectUri = new URL('.', window.location.href).href

/**
 * The page-level root: picks between the launched viewer (with a slim brand
 * bar) and the standalone connect page (with full site chrome).
 *
 * @remarks
 * The `launched` prop defaults to the URL check so production gets the real
 * branch, but tests can reach either branch with a plain boolean and no URL
 * games. One `QueryClient` for the whole page — `App` completes the SMART
 * handshake as a query on it (via `useSmartHandshake`), then hands this same
 * instance to its router context, so the exchange and every viewer read share
 * one cache.
 */
function AppRoot({
  launched = shouldCompleteSmartLaunch(),
}: {
  readonly launched?: boolean
}): JSX.Element {
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
          <main
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              maxWidth: 'var(--content-max-width)',
              margin: '0 auto',
              padding: 'var(--space-11) var(--page-padding-x)',
            }}
          >
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
