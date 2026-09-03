import { QueryClientProvider } from '@tanstack/react-query'
import { AppLanding, BrandBar, fromApp, SiteFooter, SiteHeader } from 'branding-react'
import { ConnectMenu } from 'fhir-r4-react/connect'
import { buildSmartQueryClient, shouldCompleteSmartLaunch } from 'fhir-r4-react/smart'
import { useState, type JSX } from 'react'

import { App } from './app.tsx'
import { standaloneSmartConfig } from './config.ts'
import styles from './app.module.css'

/**
 * The hybrid seam for `wildflower-importer`: wraps both the EHR-launched
 * importer and the standalone connect menu in shared Wildflower chrome.
 *
 * @param launched - Whether a SMART handshake is in progress. Read once, on
 *   mount: defaults to `shouldCompleteSmartLaunch()` against the current URL;
 *   pass explicitly in tests to exercise both branches without URL games. A
 *   later change to the prop is ignored, for the reason below.
 *
 * @remarks
 * The app root is both the OAuth redirect target and the standalone landing
 * page. A callback in the URL (`code`/`state`, no `error`) means there is a
 * handshake to complete, so render `App`; otherwise show the landing page:
 * the Importer's introduction (`AppLanding`) beside the connect menu.
 *
 * The decision is latched on mount rather than derived per render: fhirclient's
 * `oauth2.ready()` strips `code`/`state` from the URL once the exchange
 * completes, so re-reading the URL on a later render would flip a completed
 * launch back to the connect menu underneath the authenticated importer.
 */
function AppRoot({ launched }: { readonly launched?: boolean }): JSX.Element {
  const [isLaunched] = useState(() => launched ?? shouldCompleteSmartLaunch())

  // One QueryClient for the whole page: `App` completes the SMART handshake as a
  // query on it (via `useSmartHandshake`), then hands this same instance to its
  // router context, so the exchange and every app read/write share one cache.
  const [queryClient] = useState(() => buildSmartQueryClient())

  // `ConnectMenu`'s redirect target is this same root, derived from the current
  // URL so it works at whatever subdomain / path the bundle is served from.
  // Derived in render, not at module load, so this module reads `window` only
  // once a tree is mounting — never as a side effect of being imported.
  const redirectUri = new URL('.', window.location.href).href

  return (
    <QueryClientProvider client={queryClient}>
      {isLaunched ? (
        <>
          <BrandBar />
          <App />
        </>
      ) : (
        <div className={styles['standalone-page']}>
          <SiteHeader nav={fromApp} />
          <main className={styles['connect-page']}>
            <AppLanding app="importer">
              <ConnectMenu
                clientId={standaloneSmartConfig.clientId}
                scope={standaloneSmartConfig.scope}
                redirectUri={redirectUri}
              />
            </AppLanding>
          </main>
          <SiteFooter nav={fromApp} />
        </div>
      )}
    </QueryClientProvider>
  )
}

export { AppRoot }
