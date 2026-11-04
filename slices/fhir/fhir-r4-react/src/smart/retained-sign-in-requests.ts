import {
  browserSignInEnvironment,
  forgetPendingSignIn,
  PendingRequestUnusable,
  type SignInEnvironment,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { Effect, Option, Schema } from 'effect'

import type { RootArrival } from './root-arrival.ts'
import { FhirBaseUrl } from './smart-connection.ts'

/** The app's SMART registration: the client it signs in as, and the scopes it asks for. */
interface SmartRegistration {
  readonly clientId: string
  readonly scope: string
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
 * `sessionStorage`: the one rule every sign-in arrival at the app root
 * follows, before it decides what to show.
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
  })

export {
  decodeRetainedSelfAddressedSignInRequest,
  RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY,
  RETAINED_SIGN_IN_REQUEST_KEY,
  RetainedSelfAddressedSignInRequest,
  retainSelfAddressedSignInRequest,
  signInEnvironmentFor,
  takeRetainedSignInRequests,
  type SmartRegistration,
}
