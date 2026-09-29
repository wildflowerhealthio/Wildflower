import { QueryClientProvider } from '@tanstack/react-query'
import { TELEMETRY_CONSENT_COPY, type AppSectionId } from 'branding-core'
import { AppLandingPage, BrandBar } from 'branding-react'
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { ErrorBoundary } from 'react-tundraish'
import type { TelemetryConsent } from 'telemetry-core'
import {
  TelemetryConsentGate,
  TelemetryStatusControl,
  useTelemetryConsentControls,
} from 'telemetry-react'
import { configFromViteEnv, initConsentedTelemetry, Sentry, setFhirServerHost } from 'telemetry-web'

import {
  appRootRedirectUri,
  buildSmartQueryClient,
  launchErrorFrom,
  shouldCompleteSmartLaunch,
  whenSmartHandshakeReady,
  type SmartLaunchConfig,
} from 'fhir-r4-react/smart'

import { ConnectMenu } from './connect-menu.tsx'

/**
 * Where a SMART app's telemetry goes, once the visitor consents to it: the
 * app's own Sentry project and the name its events carry.
 */
interface SmartAppTelemetry {
  /**
   * The DSN of the app's Sentry project, from the app's own
   * `VITE_SENTRY_DSN_<APP>` build variable. Empty when the build names none,
   * and then nothing is reported whatever the visitor answers.
   */
  readonly dsn: string
  /**
   * The app's id, e.g. `'medications-app'`: the `app` tag on every event and
   * the OpenTelemetry service name.
   */
  readonly app: string
}

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
  /** Where the app's telemetry goes once the visitor consents to it. */
  readonly telemetry: SmartAppTelemetry
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
 * The telemetry status control, reading the answer out of the surrounding
 * `TelemetryConsentGate` and reopening its dialog when pressed.
 */
function ConsentStatusControl(): JSX.Element {
  const { consent, reopen } = useTelemetryConsentControls()
  return <TelemetryStatusControl consent={consent} copy={TELEMETRY_CONSENT_COPY} onPress={reopen} />
}

/**
 * The top-level root every self-hosted SMART app mounts: the telemetry consent
 * gate, then one `QueryClientProvider` around two branches in shared
 * Wildflower chrome.
 *
 * - **Launched** (the URL carries an OAuth callback): `BrandBar`, with the
 *   telemetry status control at its end, over `children` in an
 *   `ErrorBoundary`. The children complete the handshake as a query on the
 *   shared client (via `useSmartHandshake`).
 * - **Standalone** (a bare visit): `branding-react`'s `AppLandingPage`, the
 *   app's introduction beside the `ConnectMenu`, which shows a launch that
 *   failed and landed back here as its `arrivalProblem`, and the telemetry
 *   status control above the footer.
 *
 * @remarks
 * **Nothing starts before the visitor answers the consent dialog.** Both
 * branches render inside `TelemetryConsentGate`, so until an answer is stored
 * the page is the dialog alone: neither the connect menu nor the app mounts,
 * and no query runs. The answer goes to `initConsentedTelemetry` with
 * `telemetry`'s DSN and the tags `app` and `launch`, and the SDK starts only
 * if a switch is on. Once it runs, the root tags events with the FHIR server's
 * host when the handshake completes, reports every failed query on its client,
 * and reports the launch failure the page arrived with, once.
 *
 * The branch is latched on mount: fhirclient's `oauth2.ready()` strips
 * `code`/`state` once the exchange completes, so re-reading the URL later
 * would flip a finished launch back to the connect menu. See the
 * guardrails in `slices/smart-app/AGENTS.md`.
 */
function SmartAppRoot({
  app,
  standalone,
  telemetry,
  launched,
  children,
}: SmartAppRootProps): JSX.Element {
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
  // double-mount. Every failed query is reported; `captureException` does
  // nothing while Sentry has not been initialized, which it never is without a
  // yes, so the report needs no consent check of its own.
  const [queryClient] = useState(() =>
    buildSmartQueryClient({
      onQueryError: (queryError) => {
        Sentry.captureException(queryError, { tags: { source: 'query' } })
      },
    })
  )

  // Whether the visitor's answer has started Sentry. It stays started for the
  // page's life, whatever later answers say: the SDK's own hooks drop what a
  // withdrawn switch no longer covers.
  const [telemetryStarted, setTelemetryStarted] = useState(false)
  const launchFailureReported = useRef(false)

  const startTelemetry = (consent: TelemetryConsent): void => {
    const started = initConsentedTelemetry({
      consent,
      config: configFromViteEnv({
        sentry: { dsn: telemetry.dsn },
        otel: { serviceName: telemetry.app },
      }),
      tags: { app: telemetry.app, launch: isLaunched ? 'launched' : 'standalone' },
    })
    if (!started) return
    setTelemetryStarted(true)
    if (launchFailure !== null && !launchFailureReported.current) {
      launchFailureReported.current = true
      Sentry.captureException(launchFailure, { tags: { source: 'launch-error' } })
    }
  }

  // Once Sentry runs, tag its events with the FHIR server the app's handshake
  // connected to, as soon as that handshake completes on the shared client.
  useEffect(() => {
    if (!telemetryStarted) return undefined
    return whenSmartHandshakeReady(queryClient, (readyClient) => {
      setFhirServerHost(new URL(readyClient.state.serverUrl).host)
    })
  }, [telemetryStarted, queryClient])

  // The page root is also the OAuth redirect target. Derived in render, not at
  // module load, so importing this module never reads `window`.
  const redirectUri = appRootRedirectUri(window.location.href)

  return (
    <TelemetryConsentGate copy={TELEMETRY_CONSENT_COPY} onDecided={startTelemetry}>
      <QueryClientProvider client={queryClient}>
        {isLaunched ? (
          <>
            <BrandBar trailing={<ConsentStatusControl />} />
            <ErrorBoundary
              onError={(error, info) => {
                // A no-op while Sentry has not been initialized, as for the
                // query failures above.
                Sentry.captureException(error, {
                  extra: { componentStack: info.componentStack ?? undefined },
                })
              }}
              extraContext={{ mode: import.meta.env.MODE, app: telemetry.app }}
            >
              {children}
            </ErrorBoundary>
          </>
        ) : (
          <AppLandingPage app={app} aboveFooter={<ConsentStatusControl />}>
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
    </TelemetryConsentGate>
  )
}

export { SmartAppRoot, type SmartAppRootProps, type SmartAppTelemetry }
