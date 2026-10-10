import { QueryClientProvider } from '@tanstack/react-query'
import { APP_DESCRIPTIONS, TELEMETRY_CONSENT_COPY, type AppSectionId } from 'branding-core'
import { AppLandingPage, BrandBar } from 'branding-react'
import { Option } from 'effect'
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  CrashReportingBoundary,
  TelemetryConsentGate,
  TelemetryStatusControl,
  useConsentedTelemetryStart,
  useTelemetryConsentControls,
} from 'telemetry-react'
import { Sentry, setFhirServerHost } from 'telemetry-web'

import {
  appRootRedirectUri,
  arrivingSmartLaunchFrom,
  buildSmartQueryClient,
  isSmartHandshakeQuery,
  launchErrorFrom,
  shouldCompleteSmartLaunch,
  whenSmartHandshakeReady,
  type SmartLaunchConfig,
} from 'fhir-r4-react/smart'

import { authorizeFromLaunchPage } from './authorize-from-launch-page.ts'
import { ConnectMenu } from './connect-menu.tsx'
import { LaunchPage } from './launch-page.tsx'

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

/**
 * Why the app root was opened, latched on mount: to start a SMART launch its
 * URL carries, to complete the callback of one, or a plain visit.
 */
type RootArrival = 'launch' | 'callback' | 'visit'

/** The `launch` tag telemetry carries for each {@link RootArrival}. */
const LAUNCH_TAGS = {
  launch: 'launching',
  callback: 'launched',
  visit: 'standalone',
} as const satisfies Record<RootArrival, string>

/** Props for {@link SmartAppRoot}. */
interface SmartAppRootProps {
  /**
   * Which app this is: picks the `AppLanding` introduction on the standalone
   * page, and names the app on the launch page.
   */
  readonly app: AppSectionId
  /**
   * The app's SMART registration: what a launch the page arrives with and the
   * standalone `ConnectMenu` both authorize with. The redirect URI is this
   * page's root and the FHIR server is the launch's `iss` or the user's pick,
   * so neither is part of it.
   */
  readonly registration: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'>
  /** Where the app's telemetry goes once the visitor consents to it. */
  readonly telemetry: SmartAppTelemetry
  /**
   * Whether the URL carries a SMART callback to complete. Read once, on mount:
   * defaults to the live URL checks (`shouldCompleteSmartLaunch`, then
   * `arrivingSmartLaunchFrom`); tests pass it explicitly, and then no launch is
   * read. A later change to the prop is ignored — see the remarks on
   * {@link SmartAppRoot}.
   */
  readonly launched?: boolean
  /**
   * Replaces the page with `url` in the session history, as the launch page
   * leaves for the app root. Defaults to `window.location.replace`; tests pass
   * a spy, since jsdom's `location` cannot be spied on.
   */
  readonly replaceLocation?: (url: string) => void
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
 * The launch page, and the authorize of the launch the page arrived with,
 * once: mounted only under the consent gate, so the authorize starts once the
 * visitor has answered. The ref holds under StrictMode's second effect run,
 * and the launch works only once. A launch that fails before it leaves
 * replaces the page with the app root carrying `?launchError`.
 *
 * A page restored from the back-forward cache after leaving for the
 * authorization server holds a launch that is already spent, so it replaces
 * itself with the bare app root: a plain visit, with the connect menu.
 */
function LaunchingApp({
  app,
  registration,
  replaceLocation,
}: Pick<SmartAppRootProps, 'app' | 'registration'> & {
  readonly replaceLocation: (url: string) => void
}): JSX.Element {
  const launchAuthorized = useRef(false)
  useEffect(() => {
    if (launchAuthorized.current) return
    launchAuthorized.current = true
    void authorizeFromLaunchPage(registration, window.location.href).then((failure) => {
      if (failure !== null) replaceLocation(failure)
    })
  }, [registration, replaceLocation])

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) replaceLocation(appRootRedirectUri(window.location.href))
    }
    window.addEventListener('pageshow', onPageShow)
    return (): void => {
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [replaceLocation])

  return <LaunchPage message={`Launching ${APP_DESCRIPTIONS[app].name}…`} />
}

/** Replaces the page with `url` in the session history. */
const replaceWindowLocation = (url: string): void => {
  window.location.replace(url)
}

/**
 * The top-level root every first-party SMART app mounts: the telemetry consent
 * gate, then the launch page for a launch the URL carries, or one
 * `QueryClientProvider` around two branches in shared Wildflower chrome.
 *
 * - **Launch** (the URL carries `iss`, with or without an EHR's `launch`, and
 *   no callback): {@link LaunchPage} while the root authorizes the launch with
 *   `registration`, once, in an error boundary that reports what it catches. A
 *   launch that fails before it leaves comes back to this root as
 *   `?launchError`.
 * - **Launched** (the URL carries an OAuth callback): `BrandBar`, with the
 *   telemetry status control at its end, over `children` in an error
 *   boundary that reports what it catches. The children complete the
 *   handshake as a query on the shared client (via `useSmartHandshake`).
 * - **Standalone** (a bare visit): `branding-react`'s `AppLandingPage`, the
 *   app's introduction beside the `ConnectMenu` (in the same kind of error
 *   boundary), which shows a launch that failed and landed back here as its
 *   `arrivalProblem`, and the telemetry status control above the footer.
 *
 * @remarks
 * **Nothing starts before the visitor answers the consent dialog.** Every
 * branch renders inside `TelemetryConsentGate`, so until an answer is stored
 * the page is the dialog alone: no launch is authorized, neither the connect
 * menu nor the app mounts, and no query runs. A stored answer skips the
 * dialog, so a returning visitor's launch starts at once. A launch waits for
 * a first visitor's answer: gatekeeper refuses one older than 5 minutes, and
 * that failure comes back here as `?launchError` and lands on the connect
 * menu. A ref guards the authorize, so StrictMode's second effect run cannot
 * spend the launch twice. A page restored from the back-forward cache after
 * leaving for the authorization server does not re-run the authorize: it
 * replaces itself with the bare app root, a plain visit. The answer goes to
 * `telemetry-react`'s `useConsentedTelemetryStart` with `telemetry`'s DSN and
 * the tags `app` and `launch` (`launching`, `launched` or `standalone`), and the SDK starts only if a switch is on. Once
 * it runs, the root tags events with the FHIR server's host when the handshake
 * completes, reports every failed read on its client,
 * and reports the launch failure the page arrived with (a failed handshake
 * among them), once.
 *
 * The case is latched on mount: fhirclient's `oauth2.ready()` strips
 * `code`/`state` once the exchange completes, so re-reading the URL later
 * would flip a finished launch back to the connect menu. See the
 * guardrails in `slices/smart-app-react/AGENTS.md`.
 */
function SmartAppRoot({
  app,
  registration,
  telemetry,
  launched,
  replaceLocation = replaceWindowLocation,
  children,
}: SmartAppRootProps): JSX.Element {
  const [arrival] = useState((): RootArrival => {
    if (launched !== undefined) return launched ? 'callback' : 'visit'
    if (shouldCompleteSmartLaunch()) return 'callback'
    return Option.isSome(arrivingSmartLaunchFrom(window.location.search)) ? 'launch' : 'visit'
  })

  // A failed launch lands back here carrying its reason — our own `?launchError`
  // from the launch page or the token exchange, or the authorization server's
  // own OAuth `?error`. Latched on mount for the same reason as `arrival`:
  // completing a handshake rewrites the URL, and the menu's banner must not
  // vanish because of it. The menu drops it once the reader starts another
  // connect.
  const [launchFailure] = useState(() => launchErrorFrom())

  // One QueryClient for the whole page: the app completes the SMART handshake
  // as a query on it and runs its own reads on it too, so they share one cache
  // and the single-use code is exchanged exactly once even under StrictMode's
  // double-mount. Every failed read is reported; `captureException` does
  // nothing while Sentry has not been initialized, which it never is without a
  // yes, so the report needs no consent check of its own. A failed handshake
  // is not reported here: the app sends it back to this root as `?launchError`,
  // and it is reported there, once, as the launch failure the page arrived with.
  const [queryClient] = useState(() =>
    buildSmartQueryClient({
      onQueryError: (queryError, failedQuery) => {
        if (isSmartHandshakeQuery(failedQuery)) return
        Sentry.captureException(queryError, { tags: { source: 'query' } })
      },
    })
  )

  // The launch failure the page arrived with is reported once, as soon as an
  // answer starts Sentry.
  const { telemetryStarted, startTelemetry } = useConsentedTelemetryStart({
    dsn: telemetry.dsn,
    tags: { app: telemetry.app, launch: LAUNCH_TAGS[arrival] },
    onFirstStart: () => {
      if (launchFailure === null) return
      Sentry.captureException(launchFailure, { tags: { source: 'launch-error' } })
    },
  })

  // Once Sentry runs, tag its events with the FHIR server the app's handshake
  // connected to, as soon as that handshake completes on the shared client.
  // The callback runs inside the query cache's notification, so a server URL
  // that does not parse is reported rather than thrown there.
  useEffect(() => {
    if (!telemetryStarted) return undefined
    return whenSmartHandshakeReady(queryClient, (readyClient) => {
      const fhirServerUrl = URL.parse(readyClient.state.serverUrl)
      if (fhirServerUrl === null) {
        Sentry.captureException(
          new Error(
            `The SMART handshake's FHIR server is not a URL: ${readyClient.state.serverUrl}`
          ),
          { tags: { source: 'fhir-server-host' } }
        )
        return
      }
      setFhirServerHost(fhirServerUrl.host)
    })
  }, [telemetryStarted, queryClient])

  // The page root is also the OAuth redirect target. Derived in render, not at
  // module load, so importing this module never reads `window`.
  const redirectUri = appRootRedirectUri(window.location.href)

  return (
    <TelemetryConsentGate copy={TELEMETRY_CONSENT_COPY} onDecided={startTelemetry}>
      {arrival === 'launch' ? (
        <CrashReportingBoundary extraContext={{ app: telemetry.app }}>
          <LaunchingApp app={app} registration={registration} replaceLocation={replaceLocation} />
        </CrashReportingBoundary>
      ) : (
        <QueryClientProvider client={queryClient}>
          {arrival === 'callback' ? (
            <>
              <BrandBar trailing={<ConsentStatusControl />} />
              <CrashReportingBoundary extraContext={{ app: telemetry.app }}>
                {children}
              </CrashReportingBoundary>
            </>
          ) : (
            <AppLandingPage app={app} aboveFooter={<ConsentStatusControl />}>
              <CrashReportingBoundary extraContext={{ app: telemetry.app }} headingLevel={2}>
                <ConnectMenu
                  target="fhir-r4"
                  clientId={registration.clientId}
                  scope={registration.scope}
                  redirectUri={redirectUri}
                  arrivalProblem={launchFailure ?? undefined}
                />
              </CrashReportingBoundary>
            </AppLandingPage>
          )}
        </QueryClientProvider>
      )}
    </TelemetryConsentGate>
  )
}

export { SmartAppRoot, type SmartAppRootProps, type SmartAppTelemetry }
