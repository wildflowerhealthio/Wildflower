import {
  completeSignIn,
  pendingRequestUnrecognisedFromAnotherVersion,
  type PendingRequestUnrecognised,
  type PendingRequestUnusable,
  searchWithoutAuthorizationResponse,
  type Session,
  type SignInEnvironment,
  type SignInError,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { Data, Effect, Match, Option } from 'effect'

import {
  decodeRetainedSelfAddressedSignInRequest,
  signInEnvironmentFor,
  takeRetainedSignInRequests,
  type SmartRegistration,
} from './retained-sign-in-requests.ts'
import type { RootArrival, SignInArrival } from './root-arrival.ts'
import { decodeFhirBaseUrl, SmartConnection } from './smart-connection.ts'

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
 * The page came back from a sign-in it holds no request for: nothing was
 * retained for a self-addressed return, or `completeSignIn` found no return
 * to complete.
 */
class NoSignInInProgress extends Data.TaggedError('NoSignInInProgress')<{
  readonly reason: string
}> {}

/** What {@link NoSignInInProgress} tells the person to do. */
const NO_SIGN_IN_IN_PROGRESS_REASON =
  'This page has no sign-in in progress to complete. Connect again.'

/**
 * Redeem the code `signInReturn` carries for the sign-in `environment`
 * started.
 *
 * @remarks
 * `completeSignIn` reads the return from a query string, so the arrival is
 * written back as one. Its `None`, no return to complete, fails as
 * {@link NoSignInInProgress}.
 */
const redeemSignIn = (
  { code, state }: Data.TaggedEnum.Value<RootArrival, 'SignInReturn'>,
  environment: SignInEnvironment
): Effect.Effect<SmartConnection, SignInError | NoSignInInProgress> =>
  completeSignIn(`?${new URLSearchParams({ code, state }).toString()}`, environment).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new NoSignInInProgress({ reason: NO_SIGN_IN_IN_PROGRESS_REASON })),
        onSome: (session) => Effect.succeed(connectionOf(session)),
      })
    )
  )

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
      return yield* new NoSignInInProgress({ reason: NO_SIGN_IN_IN_PROGRESS_REASON })
    }
    const request = decodeRetainedSelfAddressedSignInRequest(retained.value)
    if (Option.isNone(request)) return yield* pendingRequestUnrecognisedFromAnotherVersion()
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
 * `taking`, with the authorization response scrubbed from the address bar
 * once it settles, whichever way: the callback leaves the URL as soon as the
 * retained sign-in requests are taken.
 */
const scrubbingAuthorizationResponse = <A, E>(taking: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.ensuring(taking, Effect.sync(scrubAuthorizationResponse))

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
   * The app root's redirect URI (`appRootRedirectUri`), derived the same
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
    const retained = yield* takeRetainedSignInRequests(landing.arrival, environment).pipe(
      scrubbingAuthorizationResponse
    )
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
    takeRetainedSignInRequests(refused, landingEnvironment(landing)).pipe(
      Effect.asVoid,
      scrubbingAuthorizationResponse
    )
  )

export {
  CallbackStateMismatch,
  completeSignInAfterRedirectHere,
  discardRefusedSignInAfterRedirectHere,
  NoSignInInProgress,
  type SignInAfterRedirectError,
  type SignInLanding,
}
