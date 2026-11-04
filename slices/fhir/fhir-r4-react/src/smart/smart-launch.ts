import {
  arrivingSmartLaunchFrom,
  AuthorizationRejected,
  beginSignIn,
  beginSignInAt,
  browserSignInEnvironment,
  completeSignIn,
  createState,
  forgetPendingSignIn,
  PendingRequestUnrecognised,
  PendingRequestUnusable,
  type PkceUnavailable,
  searchWithoutAuthorizationResponse,
  SMART_LAUNCH_PARAMS,
  type ArrivingSmartLaunch,
  type Session,
  type SignInEnvironment,
  type SignInError,
  type SmartIssuer,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { Data, Effect, Match, Option, Schema } from 'effect'

import { RootArrival, rootArrivalFrom } from './root-arrival.ts'
import { decodeFhirBaseUrl, FhirBaseUrl, SmartConnection } from './smart-connection.ts'

/**
 * Configuration for a SMART App Launch: the app's registered client, where the
 * authorization server sends the browser back to, and the FHIR server
 * (`iss`, the "issuer") to sign in to.
 */
interface SmartLaunchConfig {
  readonly clientId: string
  readonly scope: string
  readonly redirectUri: string
  /** The FHIR server base to sign in to: an EHR launch's `iss`, or a picked server. */
  readonly iss: FhirBaseUrl
}

/**
 * The `sessionStorage` key `authorization-core`'s sign-in keeps its pending
 * record at, for every SMART app on this package. `sessionStorage` is per tab,
 * so it is one key for the one sign-in a tab can be in.
 */
const PENDING_AUTHORIZATION_KEY = 'fhir-r4-react.pending-authorization'

/**
 * The `sessionStorage` key the {@link PendingOpenServer} this tab started
 * lives at until the redirect target completes it.
 */
const PENDING_CONNECTION_KEY = 'fhir-r4-react.pending-connection'

/**
 * A connection to an open server in progress, carried across the redirect in
 * `sessionStorage`: the server, and the `state` the redirect target must come
 * back with. It holds no credential.
 */
const PendingOpenServer = Schema.Struct({
  state: Schema.String,
  serverUrl: FhirBaseUrl,
})
type PendingOpenServer = Schema.Schema.Type<typeof PendingOpenServer>

const PendingOpenServerJson = Schema.parseJson(PendingOpenServer)
const encodePendingOpenServer = Schema.encodeSync(PendingOpenServerJson)
const decodePendingOpenServer = Schema.decodeUnknownOption(PendingOpenServerJson)

/** The sign-in environment for `registration`, wired to this page. */
const signInEnvironmentFor = (registration: Omit<SmartLaunchConfig, 'iss'>): SignInEnvironment =>
  browserSignInEnvironment(window, {
    clientId: registration.clientId,
    pendingKey: PENDING_AUTHORIZATION_KEY,
    scope: registration.scope,
    redirectUri: registration.redirectUri,
  })

/** Why the page cannot use the record it keeps a connection in progress in. */
const blockedStorage = (): PendingRequestUnusable =>
  new PendingRequestUnusable({
    reason:
      'This browser would not let the page use the connection it kept ' +
      '(session storage is blocked), so it cannot be completed.',
  })

/** Keep `pendingOpenServer` for the redirect target, before the page leaves. */
const rememberPendingOpenServer = (
  pendingOpenServer: PendingOpenServer
): Effect.Effect<void, PendingRequestUnusable> =>
  Effect.try({
    try: () =>
      window.sessionStorage.setItem(
        PENDING_CONNECTION_KEY,
        encodePendingOpenServer(pendingOpenServer)
      ),
    catch: blockedStorage,
  })

/**
 * Take every pending record a callback arrival can complete out of
 * `sessionStorage`, then scrub the callback from the address bar: the one rule
 * every arrival at the app root carrying `code`, `state` or `error` follows,
 * before it decides what to show.
 *
 * @returns The open-server record as stored, `None` when there is none.
 *
 * @remarks
 * A `SignInReturn` leaves `authorization-core`'s record to `completeSignIn`,
 * which takes it before it redeems the code; any other arrival forgets it. The open-server record is taken either way, and decoded
 * only by the arrival that completes it ({@link connectOpenServer}). A
 * storage that throws fails with `PendingRequestUnusable`.
 */
const takePendingConnection = (
  arrival: RootArrival,
  environment: SignInEnvironment
): Effect.Effect<Option.Option<string>, PendingRequestUnusable> =>
  Effect.gen(function* () {
    const storedOpenServer = yield* Effect.try({
      try: () => {
        const stored = window.sessionStorage.getItem(PENDING_CONNECTION_KEY)
        window.sessionStorage.removeItem(PENDING_CONNECTION_KEY)
        return Option.fromNullable(stored)
      },
      catch: blockedStorage,
    })
    if (!RootArrival.$is('SignInReturn')(arrival)) yield* forgetPendingSignIn(environment)
    return storedOpenServer
  }).pipe(Effect.ensuring(Effect.sync(scrubAuthorizationResponse)))

/** Run `beginning`, then send the browser to the authorization URL it yields. */
const leaveForAuthorization = <E>(beginning: Effect.Effect<string, E>): Effect.Effect<void, E> =>
  Effect.flatMap(beginning, (authorizeUrl) =>
    Effect.sync(() => {
      window.location.assign(authorizeUrl)
    })
  )

/**
 * Begin the SMART App Launch against `config.iss`: discover its endpoints, keep
 * what the redirect target needs, and send the browser to the authorization
 * endpoint. `launch` is the EHR's launch token for an EHR launch, and
 * `undefined` for a standalone launch.
 *
 * @remarks
 * `authorization-core`'s `beginSignIn` discovers the endpoints from
 * `{iss}/.well-known/smart-configuration` and accepts the authorization
 * endpoint only when `endpointUrlFrom` does for this page: a `javascript:`
 * URL, one carrying userinfo or a fragment, and plain http off loopback from an
 * https page are each refused. Then it fails with discovery's reason and the
 * page stays where it is.
 */
const authorizeSmartLaunch = (
  config: SmartLaunchConfig,
  launch: string | undefined
): Effect.Effect<void, SignInError> =>
  leaveForAuthorization(
    beginSignIn(config.iss, undefined, signInEnvironmentFor(config), {
      launch,
    })
  )

/**
 * Begin a standalone SMART App Launch at the already-discovered `issuer`, as
 * {@link authorizeSmartLaunch} does once it has discovered one: the probe that
 * found the issuer is the one fetch of its SMART configuration.
 */
const authorizeSmartLaunchAt = (
  issuer: SmartIssuer,
  config: Omit<SmartLaunchConfig, 'iss'>
): Effect.Effect<void, PkceUnavailable | PendingRequestUnusable> =>
  leaveForAuthorization(beginSignInAt(issuer, undefined, signInEnvironmentFor(config)))

/**
 * Configuration for connecting to an **open** FHIR server — one whose
 * `.well-known/smart-configuration` names no authorization endpoint (or serves
 * no config at all). There is no OAuth handshake: the page goes straight to
 * the redirect target, which `readySmartClient` completes into a connection
 * with no access token.
 */
interface OpenServerConfig {
  /** The FHIR server base to connect to, used with no `Authorization` header. */
  readonly fhirServiceUrl: FhirBaseUrl
  readonly redirectUri: string
}

/**
 * Begin an open-server connection: keep the server for the redirect target
 * and send the browser straight there, carrying a fresh `state`, so the page
 * usually navigates away. The URL is the app's own redirect target, not one a
 * server advertised.
 */
const authorizeOpenServer = (config: OpenServerConfig): Effect.Effect<void, PendingRequestUnusable> =>
  Effect.gen(function* () {
      const state = createState(window.crypto)
      yield* rememberPendingOpenServer({
        state,
        serverUrl: config.fhirServiceUrl,
      })
      const redirectTarget = new URL(config.redirectUri)
      redirectTarget.searchParams.set('state', state)
      window.location.assign(redirectTarget.href)
    })

/**
 * The connection a redeemed sign-in `session` is: its server, its token, and
 * the patient its token response named, if it named one.
 */
const connectionOf = (session: Session): SmartConnection =>
  new SmartConnection({
    fhirBaseUrl: decodeFhirBaseUrl(session.serverUrl),
    accessToken: Option.some(session.accessToken),
    launchPatientId: Option.fromNullable(session.patient).pipe(
      Option.filter((patientId) => patientId !== '')
    ),
  })

/**
 * Redeem the code `signInReturn` carries for the sign-in `environment`
 * started.
 *
 * @remarks
 * `completeSignIn` reads the return from a query string, so the arrival is
 * written back as one. A return that carries a code always completes or
 * fails, so its `None` (no return at all) cannot happen here.
 */
const redeemSignIn = (
  { code, state }: Data.TaggedEnum.Value<RootArrival, 'SignInReturn'>,
  environment: SignInEnvironment
): Effect.Effect<SmartConnection, SignInError> =>
  completeSignIn(`?${new URLSearchParams({ code, state }).toString()}`, environment).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.dieMessage('A sign-in return with a code completed to no session'),
        onSome: (session) => Effect.succeed(connectionOf(session)),
      })
    )
  )

/**
 * The open server the stored record names, once `selfAddressedReturn` comes
 * back with its `state`. Only an absent record means there is no connection
 * to complete.
 */
const connectOpenServer = (
  selfAddressedReturn: Data.TaggedEnum.Value<RootArrival, 'SelfAddressedSignInReturn'>,
  storedOpenServer: Option.Option<string>
): Effect.Effect<SmartConnection, AuthorizationRejected | PendingRequestUnrecognised> =>
  Effect.gen(function* () {
    if (Option.isNone(storedOpenServer)) {
      return yield* new AuthorizationRejected({
        reason: 'This page has no connection in progress to complete. Connect again.',
      })
    }
    const pendingOpenServer = decodePendingOpenServer(storedOpenServer.value)
    if (Option.isNone(pendingOpenServer)) {
      return yield* new PendingRequestUnrecognised({
        reason:
          'The connection in progress was started by a different version of this page. ' +
          'Connect again.',
      })
    }
    if (selfAddressedReturn.state !== pendingOpenServer.value.state) {
      return yield* new AuthorizationRejected({
        reason: 'The connection came back with the wrong state parameter, so it was discarded.',
      })
    }
    return new SmartConnection({
      fhirBaseUrl: pendingOpenServer.value.serverUrl,
      accessToken: Option.none(),
      launchPatientId: Option.none(),
    })
  })

/**
 * Take the authorization response out of the address bar, keeping the rest of
 * the URL and the history entry's state (a router's history tags it).
 */
const scrubAuthorizationResponse = (): void => {
  const { pathname, search, hash } = window.location
  window.history.replaceState(
    window.history.state,
    '',
    `${pathname}${searchWithoutAuthorizationResponse(search)}${hash}`
  )
}

/** The page's arrival and the sign-in environment of the app at `registration`. */
const callbackEnvironment = (
  registration: Pick<SmartLaunchConfig, 'clientId' | 'scope'>,
  servedDirectory: string | undefined
): { readonly arrival: RootArrival; readonly environment: SignInEnvironment } => ({
  arrival: rootArrivalFrom(window.location.search),
  environment: signInEnvironmentFor({
    ...registration,
    redirectUri: appRootRedirectUri(window.location.href, servedDirectory),
  }),
})

/**
 * Complete the connection on the redirect target: redeem the code a SMART
 * sign-in came back with, or accept an open server's return, and resolve to
 * the {@link SmartConnection} it made.
 *
 * @param registration - The app's SMART registration, which the code is
 *   redeemed as
 * @param servedDirectory - The directory the app is served from, as
 *   {@link appRootRedirectUri} takes it: the redirect URI the token request
 *   names is derived the same way the outbound leg derived it
 *
 * @remarks
 * Every pending record is taken first ({@link takePendingConnection}), so a
 * second completion (a reload, a remount) finds nothing to complete and
 * fails, as a page with no connection in progress does, and the callback
 * leaves the address bar whichever way the connection settles.
 */
const readySmartClient = (
  registration: Pick<SmartLaunchConfig, 'clientId' | 'scope'>,
  servedDirectory?: string
): Effect.Effect<SmartConnection, SignInError> =>
  Effect.gen(function* () {
    const { arrival, environment } = callbackEnvironment(registration, servedDirectory)
    const storedOpenServer = yield* takePendingConnection(arrival, environment)
    return yield* Match.value(arrival).pipe(
      Match.tag('SignInReturn', (signInReturn) => redeemSignIn(signInReturn, environment)),
      Match.tag('SelfAddressedSignInReturn', (selfAddressedReturn) =>
        connectOpenServer(selfAddressedReturn, storedOpenServer)
      ),
      Match.orElse(() =>
        Effect.fail(
          new AuthorizationRejected({
            reason: 'This page has no connection in progress to complete. Connect again.',
          })
        )
      )
    )
  })

/**
 * Drop every pending record and scrub the callback, for an arrival that
 * carries a callback the app root does not complete: an authorization
 * server's `?error=` return, which the root shows on the connect menu.
 *
 * @remarks
 * The same rule {@link readySmartClient} takes the records by
 * ({@link takePendingConnection}); it fails only when the storage throws.
 */
const discardPendingConnection = (
  registration: Pick<SmartLaunchConfig, 'clientId' | 'scope'>,
  servedDirectory?: string
): Effect.Effect<void, PendingRequestUnusable> =>
  Effect.suspend(() => {
    const { arrival, environment } = callbackEnvironment(registration, servedDirectory)
    return Effect.asVoid(takePendingConnection(arrival, environment))
  })

/**
 * The OAuth redirect URI for a SMART app, from the URL of any of its pages:
 * the app's served directory, `servedDirectory`, on `href`'s origin,
 * without the page's query or fragment. Without `servedDirectory` it is
 * `href`'s own directory (`new URL('.', href)`), right for an app whose every
 * page sits at its root.
 *
 * @param href - The page's URL.
 * @param servedDirectory - The directory the app is served from, as an
 *   absolute, slash-suffixed path (a routed app's basepath, e.g. `/pr-7/`). A
 *   routed app passes it, since a launch can open one of its deep routes
 *   (`/patients/123/today?iss=…`), whose own directory is no registered
 *   redirect URI.
 *
 * @remarks
 * The app root, which serves `index.html`, is the one redirect target for every
 * way in: a launch it was opened to start ({@link arrivingSmartLaunchFrom}), a
 * standalone launch from the connect menu, and a failed launch sent back with
 * `launchErrorRedirect`. It is
 * the page that completes the handshake ({@link readySmartClient}) and the page
 * that can show a failure, so a launch always returns there. Every such page
 * derives the same value, and the value is the same on the way out and on the
 * callback whatever query the page carries.
 *
 * Derived from the page URL rather than configured, so the bundle works at
 * whatever origin and path it is served from. It is not `authorization-core`'s
 * `redirectUriForPage`: there is no plaintext screen, because the registered
 * client's redirect URIs decide where a launch may return, and any userinfo the
 * page URL carries is kept.
 */
const appRootRedirectUri = (href: string, servedDirectory = '.'): string =>
  new URL(servedDirectory, href).href

export {
  appRootRedirectUri,
  /**
   * Re-exported from `authorization-core/smart-client`, like `normalizeServerUrl`:
   * the launch a page's URL asks it to start, which the app root reads to
   * authorize a launch rather than show the connect menu. The pages that sign
   * in with `authorization-core` read launches the same way without depending on
   * this package.
   */
  arrivingSmartLaunchFrom,
  authorizeOpenServer,
  authorizeSmartLaunch,
  authorizeSmartLaunchAt,
  discardPendingConnection,
  PENDING_AUTHORIZATION_KEY,
  PENDING_CONNECTION_KEY,
  readySmartClient,
  /** Re-exported with `arrivingSmartLaunchFrom`: the parameters it reads a launch from. */
  SMART_LAUNCH_PARAMS,
  type ArrivingSmartLaunch,
  type OpenServerConfig,
  type SmartLaunchConfig,
}
