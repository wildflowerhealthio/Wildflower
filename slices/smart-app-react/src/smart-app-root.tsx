import { QueryClientProvider } from '@tanstack/react-query'
import {
  APP_DESCRIPTIONS,
  TELEMETRY_CONSENT_COPY,
  type AppSectionId,
} from '@wildflowerhealthio/branding-core'
import { AppLandingPage, BrandBar } from '@wildflowerhealthio/branding-react'
import {
  CrashReportingBoundary,
  TelemetryConsentGate,
  TelemetryStatusControl,
  useConsentedTelemetryStart,
  useTelemetryConsentControls,
} from '@wildflowerhealthio/telemetry-react'
import { redactServerHost, Sentry, setFhirServerHost } from '@wildflowerhealthio/telemetry-web'
import { Effect, Match, Option } from 'effect'
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'

import {
  appRootRedirectUri,
  buildSmartQueryClient,
  discardPendingConnection,
  isSmartHandshakeQuery,
  launchError,
  type RootArrival,
  rootArrivalFrom,
  type ArrivingSmartLaunch,
  type SignInArrival,
  type SignInLanding,
  type SmartConnection,
  type SmartLaunchConfig,
} from '@wildflowerhealthio/fhir-r4-react/smart'

import { authorizeFromLaunchPage } from './authorize-from-launch-page.ts'
import { ConnectMenu } from './connect-menu.tsx'
import { LaunchPage } from './launch-page.tsx'
import { clearReturnRoute } from './return-route.ts'
import { SignInLandingContext } from './sign-in-landing.ts'

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
   * The app's id, e.g. `'medications-web'`: the `app` tag on every event and
   * the OpenTelemetry service name.
   */
  readonly app: string
}

/** The `launch` tag telemetry carries for each {@link RootArrival}. */
const LAUNCH_TAGS = {
  LaunchRequest: 'launching',
  SignInReturn: 'launched',
  SelfAddressedSignInReturn: 'launched',
  SignInRefused: 'standalone',
  Visit: 'standalone',
} as const satisfies Record<RootArrival['_tag'], string>

/**
 * The launch failure `arrival` reports, for the connect menu's banner: the
 * authorization server's refusal, or our own `?launchError` a failed launch
 * came back with.
 */
const launchFailureOf = (arrival: RootArrival): Option.Option<Error> =>
  Match.value(arrival).pipe(
    Match.tag('SignInRefused', ({ refusal }) => Option.some(launchError(Option.some(refusal)))),
    Match.tag('Visit', ({ launchError: failure }) =>
      Option.map(failure, (body) => launchError(Option.some(body)))
    ),
    Match.orElse(() => Option.none())
  )

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
   * The directory the app is served from, slash-suffixed: a routed app's
   * `SmartAppPage.basepath`. The OAuth redirect URI is this directory on the
   * page's origin (`appRootRedirectUri`), whichever of the app's routes the
   * page was opened at. Omitted, it is the page URL's own directory, right
   * for an app that is only ever opened at its root.
   */
  readonly servedDirectory?: string
  /**
   * The query string the page arrived with, read once, on mount, into its
   * `RootArrival` (`rootArrivalFrom`). Defaults to `window.location.search`;
   * tests pass one, e.g. `'?code=c&state=s'`. A later change to the prop is
   * ignored — see the remarks on {@link SmartAppRoot}.
   */
  readonly search?: string
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
  launch,
  servedDirectory,
  replaceLocation,
}: Pick<SmartAppRootProps, 'app' | 'registration' | 'servedDirectory'> & {
  readonly launch: ArrivingSmartLaunch
  readonly replaceLocation: (url: string) => void
}): JSX.Element {
  const launchAuthorized = useRef(false)
  useEffect(() => {
    if (launchAuthorized.current) return
    launchAuthorized.current = true
    void authorizeFromLaunchPage(registration, launch, window.location.href, servedDirectory).then(
      Option.map(replaceLocation)
    )
  }, [registration, launch, servedDirectory, replaceLocation])

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) {
        replaceLocation(appRootRedirectUri(window.location.href, servedDirectory))
      }
    }
    window.addEventListener('pageshow', onPageShow)
    return (): void => {
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [servedDirectory, replaceLocation])

  return <LaunchPage message={`Launching ${APP_DESCRIPTIONS[app].name}…`} />
}

/**
 * `children`, under the {@link SignInLanding} for `arrival`, which their
 * `SmartHandshakeGate` completes.
 */
function SignInLandingProvider({
  arrival,
  registration,
  appRootRedirectUri: redirectUri,
  onSignedIn,
  children,
}: SignInLanding & { readonly children: ReactNode }): JSX.Element {
  // Memoised, so the gate's effects keyed on the landing run once.
  const landing = useMemo(
    (): SignInLanding => ({ arrival, registration, appRootRedirectUri: redirectUri, onSignedIn }),
    [arrival, registration, redirectUri, onSignedIn]
  )
  return <SignInLandingContext value={landing}>{children}</SignInLandingContext>
}

/**
 * Tag Sentry's events with the host of the FHIR server `connection` names. A
 * server URL that does not parse is reported, and tagged as having no host.
 * The report leaves the URL out, and the URL is redacted as written: it can
 * name the server in a shape no URL scrubbing recognizes, such as a bare
 * hostname.
 */
const tagFhirServerHost = (connection: SmartConnection): void => {
  const fhirServerUrl = URL.parse(connection.fhirBaseUrl)
  if (fhirServerUrl === null) {
    redactServerHost(connection.fhirBaseUrl)
    Sentry.captureException(new Error("The SMART handshake's FHIR server is not a URL"), {
      tags: { source: 'fhir-server-host' },
    })
  }
  setFhirServerHost(fhirServerUrl === null ? null : fhirServerUrl.host)
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
 *   handshake as a query on the shared client (under `SmartHandshakeGate`).
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
 * a first visitor's answer: the authorization server refuses one older than 5 minutes, and
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
 * The case is latched on mount: every arrival carrying a callback has its
 * pending records taken and `code`/`state`/`error` scrubbed from the URL
 * (`readySmartClient` on a callback, `discardPendingConnection` on an OAuth
 * error return), so re-reading the URL later would flip a launch back to the
 * connect menu. See the guardrails in `slices/smart-app-react/AGENTS.md`.
 */
function SmartAppRoot({
  app,
  registration,
  telemetry,
  servedDirectory,
  search,
  replaceLocation = replaceWindowLocation,
  children,
}: SmartAppRootProps): JSX.Element {
  const [arrival] = useState(() => rootArrivalFrom(search ?? window.location.search))
  // The app root is also the OAuth redirect target, the same URI whichever of
  // the app's routes the page opened at. Derived on mount, not at module
  // load, so importing this module never reads `window`.
  const [redirectUri] = useState(() => appRootRedirectUri(window.location.href, servedDirectory))
  const [connection, setConnection] = useState<Option.Option<SmartConnection>>(Option.none())
  const onSignedIn = useCallback((signedIn: SmartConnection) => {
    setConnection(Option.some(signedIn))
  }, [])

  // A plain visit (a fresh one, a failed launch sent back here, a page back
  // from the back-forward cache) or a refused sign-in completes no launch, so
  // the route a launch saved to return to is cleared: it must not hijack a
  // later callback. A refused sign-in also takes the connection in progress,
  // as every callback arrival does; the menu shows the refusal, and a storage
  // that will not give the records up is reported.
  useEffect(() => {
    Match.value(arrival).pipe(
      Match.tag('SignInRefused', (refused) => {
        clearReturnRoute(window.sessionStorage)
        discardPendingConnection(refused, { registration, appRootRedirectUri: redirectUri }).pipe(
          Effect.tapError((discardError) =>
            Effect.sync(() => {
              Sentry.captureException(discardError, { tags: { source: 'pending-connection' } })
            })
          ),
          Effect.runFork
        )
      }),
      Match.tag('Visit', () => {
        clearReturnRoute(window.sessionStorage)
      }),
      Match.orElse(() => undefined)
    )
  }, [arrival, registration, redirectUri])

  // A failed launch lands back here carrying its reason — our own `?launchError`
  // from the launch page or the token exchange, or the authorization server's
  // own OAuth `?error` — read with the arrival, so it does not vanish when a
  // completion rewrites the URL. The menu drops it once the reader starts
  // another connect.
  const [launchFailure] = useState(() => launchFailureOf(arrival))

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
    tags: { app: telemetry.app, launch: LAUNCH_TAGS[arrival._tag] },
    onFirstStart: () => {
      Option.map(launchFailure, (failure) =>
        Sentry.captureException(failure, { tags: { source: 'launch-error' } })
      )
    },
  })

  // Once Sentry runs and the app has signed in, tag its events with the FHIR
  // server the sign-in connected to.
  useEffect(() => {
    if (telemetryStarted) Option.map(connection, tagFhirServerHost)
  }, [telemetryStarted, connection])

  const launchedApp = (signInArrival: SignInArrival): JSX.Element => (
    <QueryClientProvider client={queryClient}>
      <SignInLandingProvider
        arrival={signInArrival}
        registration={registration}
        appRootRedirectUri={redirectUri}
        onSignedIn={onSignedIn}
      >
        <BrandBar trailing={<ConsentStatusControl />} />
        <CrashReportingBoundary extraContext={{ app: telemetry.app }}>
          {children}
        </CrashReportingBoundary>
      </SignInLandingProvider>
    </QueryClientProvider>
  )
  const connectMenu = (
    <AppLandingPage app={app} aboveFooter={<ConsentStatusControl />}>
      <CrashReportingBoundary extraContext={{ app: telemetry.app }} headingLevel={2}>
        <ConnectMenu
          target="fhir-r4"
          clientId={registration.clientId}
          scope={registration.scope}
          redirectUri={redirectUri}
          arrivalProblem={Option.getOrUndefined(launchFailure)}
        />
      </CrashReportingBoundary>
    </AppLandingPage>
  )

  return (
    <TelemetryConsentGate copy={TELEMETRY_CONSENT_COPY} onDecided={startTelemetry}>
      {Match.value(arrival).pipe(
        Match.tag('LaunchRequest', ({ launch }) => (
          <CrashReportingBoundary extraContext={{ app: telemetry.app }}>
            <LaunchingApp
              app={app}
              registration={registration}
              launch={launch}
              servedDirectory={servedDirectory}
              replaceLocation={replaceLocation}
            />
          </CrashReportingBoundary>
        )),
        Match.tag('SignInReturn', 'SelfAddressedSignInReturn', launchedApp),
        Match.tag('SignInRefused', 'Visit', () => (
          <QueryClientProvider client={queryClient}>{connectMenu}</QueryClientProvider>
        )),
        Match.exhaustive
      )}
    </TelemetryConsentGate>
  )
}

export { SmartAppRoot, type SmartAppRootProps, type SmartAppTelemetry }
