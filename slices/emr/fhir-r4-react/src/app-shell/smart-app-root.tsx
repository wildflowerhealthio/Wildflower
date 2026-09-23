import { QueryClientProvider } from '@tanstack/react-query'
import type { AppSectionId } from 'branding-core'
import { AppLanding, BrandBar, fromApp, SiteFooter, SiteHeader } from 'branding-react'
import { useState, type JSX, type ReactNode } from 'react'
import { ErrorBanner } from 'react-tundraish'

import { ConnectMenu } from '../connect/connect-menu.tsx'
import { launchErrorFrom } from '../smart/launch-error.ts'
import { buildSmartQueryClient } from '../smart/self-hosted-runtime.ts'
import { shouldCompleteSmartLaunch, type SmartLaunchConfig } from '../smart/smart-launch.ts'

import styles from './smart-app-root.module.css'

/** Props for {@link SmartAppRoot}. */
interface SmartAppRootProps {
  /** Which app this is: picks the `AppLanding` introduction on the standalone page. */
  readonly app: AppSectionId
  /**
   * The SMART registration the standalone `ConnectMenu` authorizes with. The
   * redirect URI is this page's root and the FHIR server is the user's pick,
   * so neither is part of it.
   */
  readonly standalone: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'>
  /**
   * Whether the URL carries a SMART callback to complete. Read once, on mount:
   * defaults to the live URL check (`shouldCompleteSmartLaunch`); tests pass it
   * explicitly. A later change to the prop is ignored — see the remarks on
   * {@link SmartAppRoot}.
   */
  readonly launched?: boolean
  /** The app itself, rendered under `BrandBar` on the launched branch. */
  readonly children: ReactNode
}

/**
 * The top-level root every self-hosted SMART app mounts: one
 * `QueryClientProvider` around two branches in shared Wildflower chrome.
 *
 * - **Launched** (the URL carries an OAuth callback): `BrandBar` over
 *   `children`, which complete the handshake as a query on the shared client
 *   (via `useSmartHandshake`).
 * - **Standalone** (a bare visit): the full `SiteHeader` / `AppLanding` /
 *   `SiteFooter` page, the app's introduction beside the `ConnectMenu`, with an
 *   `ErrorBanner` for a launch that failed and landed back here.
 *
 * @remarks
 * The branch is latched on mount rather than derived per render: fhirclient's
 * `oauth2.ready()` strips `code`/`state` from the URL once the exchange
 * completes, so re-reading the URL on a later render would flip a completed
 * launch back to the connect menu underneath the authenticated app.
 *
 * The page root is both the OAuth redirect target and the standalone landing
 * page, so `ConnectMenu`'s redirect URI is derived from the current URL — it
 * works at whatever origin and path the bundle is served from. It is derived
 * in render, not at module load, so this module reads `window` only once a
 * tree is mounting — never as a side effect of being imported.
 */
function SmartAppRoot({ app, standalone, launched, children }: SmartAppRootProps): JSX.Element {
  const [isLaunched] = useState(() => launched ?? shouldCompleteSmartLaunch())

  // A failed launch lands back here carrying its reason — our own `?launchError`
  // from the launch page or the token exchange, or the authorization server's
  // own OAuth `?error`. Latched on mount for the same reason as `isLaunched`:
  // completing a handshake rewrites the URL, and the banner must not vanish
  // because of it.
  const [launchFailure] = useState(() => launchErrorFrom())

  // One QueryClient for the whole page: the app completes the SMART handshake
  // as a query on it and runs its own reads on it too, so they share one cache
  // and the single-use code is exchanged exactly once even under StrictMode's
  // double-mount.
  const [queryClient] = useState(() => buildSmartQueryClient())

  const redirectUri = new URL('.', window.location.href).href

  return (
    <QueryClientProvider client={queryClient}>
      {isLaunched ? (
        <>
          <BrandBar />
          {children}
        </>
      ) : (
        <div className={styles['standalone-page']}>
          <SiteHeader nav={fromApp} />
          <main className={styles['connect-page']}>
            <AppLanding app={app}>
              <ErrorBanner error={launchFailure} />
              <ConnectMenu
                clientId={standalone.clientId}
                scope={standalone.scope}
                redirectUri={redirectUri}
              />
            </AppLanding>
          </main>
          <SiteFooter />
        </div>
      )}
    </QueryClientProvider>
  )
}

export { SmartAppRoot, type SmartAppRootProps }
