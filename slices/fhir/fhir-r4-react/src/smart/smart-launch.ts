import {
  arrivingSmartLaunchFrom,
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

import type { RootArrival, SignInArrival } from './root-arrival.ts'
import { decodeFhirBaseUrl, FhirBaseUrl, SmartConnection } from './smart-connection.ts'

/** The app's SMART registration: the client it signs in as, and the scopes it asks for. */
interface SmartRegistration {
  readonly clientId: string
  readonly scope: string
}

/**
 * Configuration for a SMART App Launch: the app's registration, where the
 * authorization server sends the browser back to, and the FHIR server to sign
 * in to.
 */
interface SmartLaunchConfig extends SmartRegistration {
  readonly redirectUri: string
  /** The FHIR server base to sign in to: an EHR launch's `iss`, or a picked server. */
  readonly fhirBaseUrl: FhirBaseUrl
}

/**
 * The `sessionStorage` key `authorization-core`'s sign-in retains its sign-in
 * request at, for every SMART app on this package. `sessionStorage` is per
 * tab, so it is one key for the one sign-in a tab can be in.
 */
const RETAINED_SIGN_IN_REQUEST_KEY = 'fhir-r4-react.retained-sign-in-request'

/**
 * The `sessionStorage` key the {@link RetainedSelfAddressedSignInRequest} this
 * tab started lives at until the redirect target completes it.
 */
const RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY =
  'fhir-r4-react.retained-self-addressed-sign-in-request'

/**
 * A self-addressed sign-in in progress, retained across the redirect in
 * `sessionStorage`: the open server, and the `state` the redirect must come
 * back with. It holds no credential.
 */
const RetainedSelfAddressedSignInRequest = Schema.Struct({
  /** The `state` the redirect carries, which its return must carry back. */
  expectedState: Schema.String,
  fhirBaseUrl: FhirBaseUrl,
})
type RetainedSelfAddressedSignInRequest = Schema.Schema.Type<
  typeof RetainedSelfAddressedSignInRequest
>

const RetainedSelfAddressedSignInRequestJson = Schema.parseJson(RetainedSelfAddressedSignInRequest)
const encodeRetainedSelfAddressedSignInRequest = Schema.encodeSync(
  RetainedSelfAddressedSignInRequestJson
)
const decodeRetainedSelfAddressedSignInRequest = Schema.decodeUnknownOption(
  RetainedSelfAddressedSignInRequestJson
)

/** The sign-in environment for `registration`, wired to this page. */
const signInEnvironmentFor = (
  registration: SmartRegistration & { readonly redirectUri: string }
): SignInEnvironment =>
  browserSignInEnvironment(window, {
    clientId: registration.clientId,
    pendingKey: RETAINED_SIGN_IN_REQUEST_KEY,
    scope: registration.scope,
    redirectUri: registration.redirectUri,
  })

/** Why the page cannot use the sign-in request it retained. */
const blockedStorage = (): PendingRequestUnusable =>
  new PendingRequestUnusable({
    reason:
      'This browser would not let the page use the sign-in request it kept ' +
      '(session storage is blocked), so it cannot be completed.',
  })

/** Retain `request` for the redirect's return, before the page leaves. */
const retainSelfAddressedSignInRequest = (
  request: RetainedSelfAddressedSignInRequest
): Effect.Effect<void, PendingRequestUnusable> =>
  Effect.try({
    try: () =>
      window.sessionStorage.setItem(
        RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY,
        encodeRetainedSelfAddressedSignInRequest(request)
      ),
    catch: blockedStorage,
  })

/**
 * Take every retained sign-in request an arrival can complete out of
 * `sessionStorage`, then scrub the callback from the address bar: the one rule
 * every sign-in arrival at the app root follows, before it decides what to
 * show.
 *
 * @returns The retained self-addressed sign-in request as stored, `None` when
 *   there is none.
 *
 * @remarks
 * A `SignInReturn` leaves `authorization-core`'s retained request to
 * `completeSignIn`, which takes it before it redeems the code; any other
 * arrival forgets it. The self-addressed request is taken either way, and
 * decoded only by the arrival that completes it
 * ({@link completeSelfAddressedSignIn}). A storage that throws fails with
 * `PendingRequestUnusable`.
 */
const takeRetainedSignInRequests = (
  arrival: RootArrival,
  environment: SignInEnvironment
): Effect.Effect<Option.Option<string>, PendingRequestUnusable> =>
  Effect.gen(function* () {
    const retained = yield* Effect.try({
      try: () => {
        const stored = window.sessionStorage.getItem(RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY)
        window.sessionStorage.removeItem(RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY)
        return Option.fromNullable(stored)
      },
      catch: blockedStorage,
    })
    if (arrival._tag !== 'SignInReturn') yield* forgetPendingSignIn(environment)
    return retained
  }).pipe(Effect.ensuring(Effect.sync(scrubAuthorizationResponse)))

/** Run `beginning`, then send the browser to the authorization URL it yields. */
const redirectToAuthorization = <E>(beginning: Effect.Effect<string, E>): Effect.Effect<void, E> =>
  Effect.flatMap(beginning, (authorizeUrl) =>
    Effect.sync(() => {
      window.location.assign(authorizeUrl)
    })
  )

/**
 * Sign in to `config.fhirBaseUrl`: discover its endpoints, retain what the
 * return needs, and send the browser to the authorization endpoint. `launch`
 * is the EHR's launch token for an EHR launch, and `undefined` for a
 * standalone launch.
 *
 * @remarks
 * `authorization-core`'s `beginSignIn` discovers the endpoints from
 * `{fhirBaseUrl}/.well-known/smart-configuration` and accepts the authorization
 * endpoint only when `endpointUrlFrom` does for this page: a `javascript:`
 * URL, one carrying userinfo or a fragment, and plain http off loopback from an
 * https page are each refused. Then it fails with discovery's reason and the
 * page stays where it is.
 */
const redirectToSignIn = (
  config: SmartLaunchConfig,
  launch: string | undefined
): Effect.Effect<void, SignInError> =>
  redirectToAuthorization(
    beginSignIn(config.fhirBaseUrl, undefined, signInEnvironmentFor(config), {
      launch,
    })
  )

/**
 * Sign in at the already-`discovered` SMART server, as {@link redirectToSignIn}
 * does once it has discovered one: the probe that discovered it is the one
 * fetch of its SMART configuration.
 */
const redirectToSignInAt = (
  discovered: SmartIssuer,
  config: Omit<SmartLaunchConfig, 'fhirBaseUrl'>
): Effect.Effect<void, PkceUnavailable | PendingRequestUnusable> =>
  redirectToAuthorization(beginSignInAt(discovered, undefined, signInEnvironmentFor(config)))

/**
 * Configuration for a self-addressed sign-in to an **open** FHIR server — one
 * whose `.well-known/smart-configuration` names no authorization endpoint (or
 * serves no config at all).
 */
interface SelfAddressedSignInConfig {
  /** The FHIR server base to connect to, used with no `Authorization` header. */
  readonly fhirBaseUrl: FhirBaseUrl
  /** The app root the sign-in is addressed to. */
  readonly redirectUri: string
}

/**
 * Sign in to an open server by addressing the redirect to this page.
 *
 * @remarks
 * An open server has no authorization server, so the page signs in by
 * addressing the redirect to itself: it keeps the server and an
 * `expectedState` under {@link RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY},
 * then redirects straight back here. On return the `state` must match, so a
 * link someone else crafted cannot make the app connect to a server they
 * chose.
 */
const redirectToSelfAddressedSignInReturn = (
  config: SelfAddressedSignInConfig
): Effect.Effect<void, PendingRequestUnusable> =>
  Effect.gen(function* () {
    const expectedState = createState(window.crypto)
    yield* retainSelfAddressedSignInRequest({ expectedState, fhirBaseUrl: config.fhirBaseUrl })
    const redirectTarget = new URL(config.redirectUri)
    redirectTarget.searchParams.set('state', expectedState)
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

/** The page came back from a self-addressed sign-in it holds no request for. */
class NoSignInInProgress extends Data.TaggedError('NoSignInInProgress')<{
  readonly reason: string
}> {}

/**
 * A self-addressed sign-in came back with a `state` other than the one its
 * retained request expects: a link the page did not make.
 */
class CallbackStateMismatch extends Data.TaggedError('CallbackStateMismatch')<{
  readonly reason: string
}> {}

/** Every way completing a sign-in after its redirect can fail. */
type SignInAfterRedirectError = SignInError | NoSignInInProgress | CallbackStateMismatch

/**
 * The open server the `retained` request names, once `selfAddressedReturn`
 * comes back with its expected `state`. Only an absent request means there is
 * no sign-in to complete.
 */
const completeSelfAddressedSignIn = (
  selfAddressedReturn: Data.TaggedEnum.Value<RootArrival, 'SelfAddressedSignInReturn'>,
  retained: Option.Option<string>
): Effect.Effect<
  SmartConnection,
  NoSignInInProgress | PendingRequestUnrecognised | CallbackStateMismatch
> =>
  Effect.gen(function* () {
    if (Option.isNone(retained)) {
      return yield* new NoSignInInProgress({
        reason: 'This page has no sign-in in progress to complete. Connect again.',
      })
    }
    const request = decodeRetainedSelfAddressedSignInRequest(retained.value)
    if (Option.isNone(request)) {
      return yield* new PendingRequestUnrecognised({
        reason:
          'The sign-in in progress was started by a different version of this page. ' +
          'Connect again.',
      })
    }
    if (selfAddressedReturn.state !== request.value.expectedState) {
      return yield* new CallbackStateMismatch({
        reason: 'The sign-in came back with the wrong state parameter, so it was discarded.',
      })
    }
    return new SmartConnection({
      fhirBaseUrl: request.value.fhirBaseUrl,
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

/**
 * The sign-in a page landed on after its redirect, and what the page needs
 * to finish it: the app root hands it to `SmartHandshakeGate`.
 */
interface SignInLanding {
  /** The sign-in the page's query string carries. */
  readonly arrival: SignInArrival
  /** The app's SMART registration, which the code is redeemed as. */
  readonly registration: SmartRegistration
  /**
   * The app root's redirect URI ({@link appRootRedirectUri}), derived the same
   * way the outbound leg derived it, so the token request names the redirect
   * URI the launch sent.
   */
  readonly appRootRedirectUri: string
  /** Called once with the connection the completed sign-in made. */
  readonly onSignedIn: (connection: SmartConnection) => void
}

/** The sign-in environment of the app at `landing`. */
const landingEnvironment = (
  landing: Pick<SignInLanding, 'registration' | 'appRootRedirectUri'>
): SignInEnvironment =>
  signInEnvironmentFor({ ...landing.registration, redirectUri: landing.appRootRedirectUri })

/**
 * Complete the sign-in the page landed on after its redirect: redeem the code
 * a sign-in's return carries, or accept a self-addressed sign-in's return, and
 * resolve to the {@link SmartConnection} it made.
 *
 * @param landing - The sign-in the page landed on, the registration it
 *   redeems as, and the redirect URI the token request names
 *
 * @remarks
 * Every retained sign-in request is taken first
 * ({@link takeRetainedSignInRequests}), so a second completion (a reload, a
 * remount) finds nothing to complete and fails, as a page with no sign-in in
 * progress does, and the callback leaves the address bar whichever way the
 * sign-in settles.
 */
const completeSignInAfterRedirectHere = (
  landing: Pick<SignInLanding, 'arrival' | 'registration' | 'appRootRedirectUri'>
): Effect.Effect<SmartConnection, SignInAfterRedirectError> =>
  Effect.gen(function* () {
    const environment = landingEnvironment(landing)
    const retained = yield* takeRetainedSignInRequests(landing.arrival, environment)
    return yield* Match.value(landing.arrival).pipe(
      Match.tagsExhaustive({
        SignInReturn: (signInReturn) => redeemSignIn(signInReturn, environment),
        SelfAddressedSignInReturn: (selfAddressedReturn) =>
          completeSelfAddressedSignIn(selfAddressedReturn, retained),
      })
    )
  })

/**
 * Drop every retained sign-in request and scrub the callback, for the
 * authorization server's refusal, which the root shows on the connect menu.
 *
 * @param refused - The refusal the page landed on
 * @param landing - The registration and redirect URI of the app at the root
 *
 * @remarks
 * The same rule {@link completeSignInAfterRedirectHere} takes the records by
 * ({@link takeRetainedSignInRequests}); it fails only when the storage throws.
 */
const discardRefusedSignInAfterRedirectHere = (
  refused: Data.TaggedEnum.Value<RootArrival, 'SignInRefused'>,
  landing: Pick<SignInLanding, 'registration' | 'appRootRedirectUri'>
): Effect.Effect<void, PendingRequestUnusable> =>
  Effect.suspend(() =>
    Effect.asVoid(takeRetainedSignInRequests(refused, landingEnvironment(landing)))
  )

/**
 * The OAuth redirect URI for a SMART app, from the URL of any of its pages:
 * the directory the app is served from, `basepath`, on `href`'s origin,
 * without the page's query or fragment. Without `basepath` it is
 * `href`'s own directory (`new URL('.', href)`), right for an app whose every
 * page sits at its root.
 *
 * @param href - The page's URL.
 * @param basepath - The directory the app is served from, as an absolute,
 *   slash-suffixed path (`SmartAppPage.basepath`, e.g. `/pr-7/`). A routed app
 *   passes it, since a launch can open one of its deep routes
 *   (`/patients/123/today?iss=…`), whose own directory is no registered
 *   redirect URI.
 *
 * @remarks
 * The app root, which serves `index.html`, is the one redirect target for every
 * way in: a launch it was opened to start ({@link arrivingSmartLaunchFrom}), a
 * standalone launch from the connect menu, and a failed launch sent back with
 * `launchErrorRedirect`. It is the page that completes the sign-in
 * ({@link completeSignInAfterRedirectHere}) and the page that can show a
 * failure, so a launch always returns there. Every such page
 * derives the same value, and the value is the same on the way out and on the
 * callback whatever query the page carries.
 *
 * Derived from the page URL rather than configured, so the bundle works at
 * whatever origin and path it is served from. It is not `authorization-core`'s
 * `redirectUriForPage`: there is no plaintext screen, because the registered
 * client's redirect URIs decide where a launch may return, and any userinfo the
 * page URL carries is kept.
 */
const appRootRedirectUri = (href: string, basepath = '.'): string =>
  new URL(basepath, href).href

export {
  appRootRedirectUri,
  CallbackStateMismatch,
  NoSignInInProgress,
  /**
   * Re-exported from `authorization-core/smart-client`, like `normalizeServerUrl`:
   * the launch a page's URL asks it to start, which the app root reads to
   * authorize a launch rather than show the connect menu. The pages that sign
   * in with `authorization-core` read launches the same way without depending on
   * this package.
   */
  arrivingSmartLaunchFrom,
  redirectToSelfAddressedSignInReturn,
  redirectToSignIn,
  redirectToSignInAt,
  discardRefusedSignInAfterRedirectHere,
  RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY,
  RETAINED_SIGN_IN_REQUEST_KEY,
  completeSignInAfterRedirectHere,
  /** Re-exported with `arrivingSmartLaunchFrom`: the parameters it reads a launch from. */
  SMART_LAUNCH_PARAMS,
  type ArrivingSmartLaunch,
  type SelfAddressedSignInConfig,
  type SignInAfterRedirectError,
  type SignInLanding,
  type SmartLaunchConfig,
  type SmartRegistration,
}
