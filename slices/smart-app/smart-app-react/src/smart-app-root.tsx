import { QueryClientProvider } from '@tanstack/react-query'
import type { AppSectionId } from 'branding-core'
import { AppLandingPage, BrandBar } from 'branding-react'
import { useState, type JSX, type ReactNode } from 'react'

import {
  appRootRedirectUri,
  buildSmartQueryClient,
  launchErrorFrom,
  shouldCompleteSmartLaunch,
  type SmartLaunchConfig,
} from 'fhir-r4-react/smart'

import { ConnectMenu } from './connect-menu.tsx'

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
 * - **Standalone** (a bare visit): `branding-react`'s `AppLandingPage`, the
 *   app's introduction beside the `ConnectMenu`, which shows a launch that
 *   failed and landed back here as its `arrivalProblem`.
 *
 * @remarks
 * The branch is latched on mount: fhirclient's `oauth2.ready()` strips
 * `code`/`state` once the exchange completes, so re-reading the URL later
 * would flip a finished launch back to the connect menu. See the
 * guardrails in `slices/smart-app/AGENTS.md`.
 */
function SmartAppRoot({ app, standalone, launched, children }: SmartAppRootProps): JSX.Element {
  const [isLaunched] = useState(() => launched ?? shouldCompleteSmartLaunch())

  // A failed launch lands back here carrying its reason — our own `?launchError`
  // from the launch page or the token exchange, or the authorization server's
  // own OAuth `?error`. Latched on mount for the same reason as `isLaunched`:
  // completing a handshake rewrites the URL, and the menu's banner must not
  // vanish because of it. The menu drops it once the reader starts another
  // connect.
  const [launchFailure] = useState(() => launchErrorFrom())

  // One QueryClient for the whole page: the app completes the SMART handshake
  // as a query on it and runs its own reads on it too, so they share one cache
  // and the single-use code is exchanged exactly once even under StrictMode's
  // double-mount.
  const [queryClient] = useState(() => buildSmartQueryClient())

  // The page root is also the OAuth redirect target. Derived in render, not at
  // module load, so importing this module never reads `window`.
  const redirectUri = appRootRedirectUri(window.location.href)

  return (
    <QueryClientProvider client={queryClient}>
      {isLaunched ? (
        <>
          <BrandBar />
          {children}
        </>
      ) : (
        <AppLandingPage app={app}>
          <ConnectMenu
            target="fhir-r4"
            clientId={standalone.clientId}
            scope={standalone.scope}
            redirectUri={redirectUri}
            arrivalProblem={launchFailure ?? undefined}
          />
        </AppLandingPage>
      )}
    </QueryClientProvider>
  )
}

export { SmartAppRoot, type SmartAppRootProps }
