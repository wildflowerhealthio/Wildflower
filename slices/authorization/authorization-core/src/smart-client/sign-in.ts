/**
 * The two halves of a sign-in, each written as one `Effect` over an injected
 * environment: {@link beginSignIn} discovers the target's OAuth endpoints and
 * builds the URL to leave for (a standalone launch, or an EHR launch when the
 * app hands it one) — {@link beginSignInAt} when the caller has already
 * discovered them — and {@link completeSignIn} picks the flow back up when the
 * browser comes back and redeems the code.
 *
 * Neither navigates and neither touches the DOM — `beginSignIn` *yields* the
 * URL for the app to assign — so both are drivable from tests with a stub
 * fetch, fixed random bytes and a plain object standing in for
 * `sessionStorage`.
 *
 * Nothing here knows which app it is running for: the client id, the requested
 * scopes, the redirect URI and the `sessionStorage` key all arrive in the
 * {@link SignInEnvironment}.
 *
 * ## The error channel
 *
 * Every way a sign-in can fail is a tagged error in {@link SignInError}, raised
 * where it happens: {@link PkceUnavailable} and {@link DiscoveryFailed} from the
 * modules that own those steps, {@link RetainedRequestUnusable} and
 * {@link RetainedRequestUnrecognised} from the storage round trip here, {@link AuthorizationRejected} and
 * {@link TokenExchangeFailed} from the flow's pure validation. Nothing throws
 * and nothing returns an ad-hoc `{ ok }` union; the app runs the Effect at one
 * boundary and renders `error.reason` wherever it shows status.
 *
 * ## Token custody
 *
 * The access token is the Effect's success value and is never written anywhere
 * by this module: no `localStorage`, no `sessionStorage`, no cookie. The client
 * is a public page and the token it obtains can be admin-capable, so it belongs
 * in one in-memory binding that dies with the tab — the same policy
 * `makeBearerAuthStateStore` follows for the same reason
 * (`slices/authorization/docs/Auth Token Storage Explanation.md`). The only thing
 * that does reach `sessionStorage` is the pending record — no credential, and
 * deleted the instant the client returns, before the code is even redeemed.
 */

import { HttpClientRequest, type HttpClient } from '@effect/platform'
import { Data, Effect, Option } from 'effect'

import {
  authorizationRedirectOutcome,
  authorizationRequestUrl,
  isAuthorizationResponse,
  parseRetainedSignInRequest,
  parseTokenResponse,
  serializeRetainedSignInRequest,
  tokenRequestBody,
  type AccessGrant,
  type AuthorizationRejected,
  type AuthorizationRequestParameters,
  type RetainedSignInRequest,
  TokenExchangeFailed,
} from './authorization-flow.ts'
import { codeChallengeS256, createCodeVerifier, createState } from './pkce.ts'
import type { PkceUnavailable } from './pkce.ts'
import {
  RetainedRequestUnusable,
  RetainedSignInRequestStore,
  SignInCrypto,
  signInHttpClient,
  type SignInServices,
} from './sign-in-services.ts'
import {
  discoverSmartEndpoints,
  type DiscoveryFailed,
  type DiscoveredSmartServer,
  type SmartServer,
} from './smart-discovery.ts'

/**
 * Raised when the storage holds a pending record that does not read as one:
 * a record a different version of the page wrote, or one edited by hand.
 */
class RetainedRequestUnrecognised extends Data.TaggedError('RetainedRequestUnrecognised')<{
  readonly reason: string
}> {}

/**
 * Raised when the token request gets no response at all: the token endpoint
 * is down, or the browser blocked the request (the two look the same to the
 * page).
 */
class TokenEndpointUnreachable extends Data.TaggedError('TokenEndpointUnreachable')<{
  readonly reason: string
}> {}

/** Everything a sign-in can fail with, whichever half it fails in. */
type SignInError =
  | DiscoveryFailed
  | PkceUnavailable
  | RetainedRequestUnusable
  | RetainedRequestUnrecognised
  | AuthorizationRejected
  | TokenEndpointUnreachable
  | TokenExchangeFailed

/**
 * What the app is registered as, where it comes back to, and what it asks
 * for. Every field is the browser-side reading of a seeded `clients` row: a
 * value that drifts from the row fails the flow at `/oauth/authorize` rather
 * than degrading quietly.
 */
interface ClientRegistration {
  /** The `client_id` this app is registered as. */
  readonly clientId: string
  /** The space-delimited `scope` parameter to request (RFC 6749 §3.3). */
  readonly scope: string
  /** The redirect URI to send, which must be one the server will honour. */
  readonly redirectUri: string
}

/**
 * What an authorization request may carry for one sign-in alone, beyond what
 * the app's registration and the server's discovery fix.
 */
type AuthorizationRequestExtras = Pick<AuthorizationRequestParameters, 'launch' | 'prompt'>

/**
 * What one sign-in carries beyond the app's registration: the
 * {@link AuthorizationRequestExtras}, and `returnTo`, the in-app path the app
 * wants to land on once signed in. `returnTo` rides the pending record and
 * comes back as {@link Session.returnTo}, because the registered redirect URI
 * can't carry it; absent when the app has nowhere particular to go.
 */
interface SignInOptions extends AuthorizationRequestExtras {
  readonly returnTo?: string | undefined
}

/**
 * Start a sign-in against `serverUrl`: discover its endpoints, then begin the
 * sign-in there as {@link beginSignInAt} does.
 *
 * The SMART `iss` — the FHIR base whose `.well-known/smart-configuration`
 * answered, and the `aud` the authorization request names — is `serverUrl`
 * itself (a Wildflower server serves FHIR at its root), and
 * `discoverSmartEndpoints` reads which kind of server it is.
 */
const beginSignIn = (
  serverUrl: string,
  registration: ClientRegistration,
  options: SignInOptions = {}
): Effect.Effect<string, SignInError, SignInServices> =>
  discoverSmartEndpoints(serverUrl).pipe(
    Effect.flatMap((discovered) => beginSignInAt(discovered, registration, options))
  )

/**
 * Start a sign-in at the already-discovered `issuer`: mint the PKCE pair and
 * the `state`, retain what the return leg needs, and yield the authorization
 * URL to navigate to.
 *
 * The issuer's FHIR base is the server the pending record and the
 * {@link Session} name. Only the endpoints discovered there ride the pending
 * record, so the return leg needs nothing more.
 *
 * `options` carries what this sign-in alone adds (see {@link SignInOptions}).
 * `returnTo` rides the pending record. `launch` and `prompt` go into the
 * authorization request only, since the return leg needs neither: `launch`,
 * the SMART EHR launch the app was opened with, sent so the server can tie the
 * sign-in to it (without one, or with an empty one, the request is a
 * standalone launch); and `prompt`, sent to show the server's limited page
 * again.
 *
 * The pending record is written **before** the URL is yielded, so a caller
 * cannot navigate away from a flow whose verifier was never saved.
 */
const beginSignInAt = (
  discovered: DiscoveredSmartServer,
  registration: ClientRegistration,
  { returnTo, ...request }: SignInOptions = {}
): Effect.Effect<
  string,
  PkceUnavailable | RetainedRequestUnusable,
  SignInCrypto | RetainedSignInRequestStore
> =>
  Effect.gen(function* () {
    const { smartServer, endpoints } = discovered
    const crypto = yield* SignInCrypto
    const store = yield* RetainedSignInRequestStore
    const codeVerifier = createCodeVerifier(crypto.random)
    const state = createState(crypto.random)
    const codeChallenge = yield* codeChallengeS256(codeVerifier, crypto.subtle)

    yield* store.retain(
      serializeRetainedSignInRequest({
        state,
        codeVerifier,
        smartServer,
        tokenEndpoint: endpoints.tokenEndpoint,
        returnTo,
      })
    )

    return authorizationRequestUrl(endpoints.authorizationEndpoint, {
      clientId: registration.clientId,
      redirectUri: registration.redirectUri,
      scope: registration.scope,
      state,
      codeChallenge,
      audience: smartServer.fhirBaseUrl,
      ...request,
    })
  })

/** A signed-in session: an in-memory token and what it is good for. */
interface Session {
  readonly accessToken: string
  /** The scopes the Owner actually granted. */
  readonly scope: string
  /**
   * Which kind of server the token was issued by, and its FHIR base: the
   * server the token is for, which requests must go to.
   */
  readonly smartServer: SmartServer
  readonly expiresInSeconds: number | undefined
  /** The patient in context, when the token response named one. */
  readonly patient: string | undefined
  /**
   * The in-app path the sign-in was started to reach — `beginSignIn`'s
   * `returnTo`, unsanitised. `undefined` when none was named.
   */
  readonly returnTo: string | undefined
}

/**
 * Finish a sign-in from the query string the client came back on: `None` when
 * this page load is not a return from the authorization server (the common
 * case) or is a return that carries no code to redeem, a {@link Session} when
 * it carries one and the code redeemed.
 *
 * Any authorization-response parameter (`code`, `state`, `error`, …) makes the
 * load a return leg, and a return leg takes the pending record: it is
 * single-use, so it is dropped before the code is redeemed, and on the rejected
 * paths too, so a discarded flow cannot leave a record behind that makes a later
 * stray `?code=` look legitimate. A load that is no return leg leaves storage
 * untouched.
 */
const completeSignIn = (
  search: string,
  registration: ClientRegistration
): Effect.Effect<
  Option.Option<Session>,
  SignInError,
  HttpClient.HttpClient | RetainedSignInRequestStore
> =>
  Effect.gen(function* () {
    if (!isAuthorizationResponse(search)) return Option.none()
    const stored = yield* takeRetainedSignInRequest
    const returning = yield* authorizationRedirectOutcome(search, stored)
    if (Option.isNone(returning)) return Option.none()
    const { code, retained } = returning.value

    const client = yield* signInHttpClient
    const response = yield* client
      .execute(
        HttpClientRequest.post(retained.tokenEndpoint).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyText(
            tokenRequestBody({
              code,
              codeVerifier: retained.codeVerifier,
              redirectUri: registration.redirectUri,
              clientId: registration.clientId,
            }),
            'application/x-www-form-urlencoded'
          )
        )
      )
      .pipe(
        Effect.mapError(
          () =>
            new TokenEndpointUnreachable({
              reason: `Could not reach the token endpoint at ${retained.tokenEndpoint}.`,
            })
        )
      )
    const body = yield* response.json.pipe(
      Effect.mapError(
        () => new TokenExchangeFailed({ reason: 'The token endpoint did not answer with JSON.' })
      )
    )
    const grant = yield* parseTokenResponse(body)
    return Option.some(sessionFrom(grant, retained))
  })

/**
 * Why a retained sign-in request that does not read as one cannot be
 * completed: the one wording for every sign-in request a page retains across
 * the redirect, this module's and an app's own.
 */
const retainedRequestUnrecognisedFromAnotherVersion = (): RetainedRequestUnrecognised =>
  new RetainedRequestUnrecognised({
    reason:
      'The sign-in in progress was started by a different version of this page. Sign in again.',
  })

/**
 * Take the pending record out of the {@link RetainedSignInRequestStore}: read
 * it and drop it. `None` only when there is none; a store that refuses the
 * read fails with {@link RetainedRequestUnusable} (one that refuses only the
 * removal does not: the record was read), and a record that does not read as
 * one with {@link RetainedRequestUnrecognised}.
 */
const takeRetainedSignInRequest: Effect.Effect<
  Option.Option<RetainedSignInRequest>,
  RetainedRequestUnusable | RetainedRequestUnrecognised,
  RetainedSignInRequestStore
> = Effect.gen(function* () {
  const store = yield* RetainedSignInRequestStore
  const stored = yield* store.take
  if (Option.isNone(stored)) return Option.none()
  const retained = parseRetainedSignInRequest(stored.value)
  if (Option.isNone(retained)) return yield* retainedRequestUnrecognisedFromAnotherVersion()
  return retained
})

/**
 * Drop the sign-in the {@link RetainedSignInRequestStore} holds, without
 * reading it: for a page that completes some other flow on its return leg and
 * must not leave this one's record behind. A store that refuses removal fails
 * with {@link RetainedRequestUnusable}.
 */
const forgetRetainedSignInRequest: Effect.Effect<
  void,
  RetainedRequestUnusable,
  RetainedSignInRequestStore
> = Effect.flatMap(RetainedSignInRequestStore, (store) => store.forget)

/** The session a `grant` redeemed for the `retained` request becomes. */
const sessionFrom = (grant: AccessGrant, retained: RetainedSignInRequest): Session => ({
  accessToken: grant.accessToken,
  scope: grant.scope,
  smartServer: retained.smartServer,
  expiresInSeconds: grant.expiresInSeconds,
  patient: grant.patient,
  returnTo: retained.returnTo,
})

export {
  RetainedRequestUnrecognised,
  RetainedRequestUnusable,
  TokenEndpointUnreachable,
  beginSignIn,
  beginSignInAt,
  completeSignIn,
  forgetRetainedSignInRequest,
  retainedRequestUnrecognisedFromAnotherVersion,
}
export type { AuthorizationRequestExtras, ClientRegistration, SignInError, SignInOptions, Session }
