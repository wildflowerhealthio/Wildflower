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
 * modules that own those steps, {@link PendingRequestUnusable} and
 * {@link PendingRequestUnrecognised} from the storage round trip here, {@link AuthorizationRejected} and
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

import {
  removeStorageItem,
  setStorageItem,
  type StorageBlocked,
  takeStorageItem,
} from '@wildflowerhealthio/kitchen-sink'
import { Data, Effect, Match, Option } from 'effect'

import {
  authorizationRedirectOutcome,
  authorizationRequestUrl,
  isAuthorizationResponse,
  parsePendingAuthorization,
  parseTokenResponse,
  serializePendingAuthorization,
  tokenRequestBody,
  type AccessGrant,
  type AuthorizationRejected,
  type AuthorizationRequestParameters,
  type PendingAuthorization,
  type TokenExchangeFailed,
} from './authorization-flow.ts'
import { codeChallengeS256, createCodeVerifier, createState } from './pkce.ts'
import type { DigestSource, PkceUnavailable, RandomBytesSource } from './pkce.ts'
import {
  discoverSmartEndpoints,
  type DiscoveryFailed,
  type SmartIssuer,
  type SmartServer,
} from './smart-discovery.ts'

/**
 * Raised when the browser will not carry the pending request across the
 * redirect (Safari's private mode throws on `setItem`, and a blocked storage
 * throws on every read), or when the token endpoint cannot be reached to
 * redeem the code.
 */
class PendingRequestUnusable extends Data.TaggedError('PendingRequestUnusable')<{
  readonly reason: string
}> {}

/**
 * Raised when the storage holds a pending record that does not read as one:
 * a record a different version of the page wrote, or one edited by hand.
 */
class PendingRequestUnrecognised extends Data.TaggedError('PendingRequestUnrecognised')<{
  readonly reason: string
}> {}

/** Everything a sign-in can fail with, whichever half it fails in. */
type SignInError =
  | DiscoveryFailed
  | PkceUnavailable
  | PendingRequestUnusable
  | PendingRequestUnrecognised
  | AuthorizationRejected
  | TokenExchangeFailed

/** The `sessionStorage`-shaped slice the flow needs. */
interface PendingStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Everything impure — and everything app-specific — the flow depends on,
 * supplied by the caller.
 */
interface SignInEnvironment {
  readonly fetch: typeof globalThis.fetch
  readonly random: RandomBytesSource
  readonly subtle: DigestSource
  readonly store: PendingStore
  /**
   * The `sessionStorage` key the pending record lives at (see
   * `ClientRegistration.pendingKey`).
   */
  readonly pendingKey: string
  /** The `client_id` this app is registered as. */
  readonly clientId: string
  /** The space-delimited `scope` parameter to request (RFC 6749 §3.3). */
  readonly scope: string
  /** The redirect URI to send, which must be one the server will honour. */
  readonly redirectUri: string
  /** Whether the client itself is on a secure page (an `https:` document). */
  readonly pageIsSecure: boolean
}

/**
 * What an authorization request may carry for one sign-in alone, beyond what
 * the app's registration and the server's discovery fix.
 */
type AuthorizationRequestExtras = Pick<AuthorizationRequestParameters, 'launch' | 'prompt'>

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
  returnTo: string | undefined,
  environment: SignInEnvironment,
  request: AuthorizationRequestExtras = {}
): Effect.Effect<string, SignInError> =>
  discoverSmartEndpoints(serverUrl, {
    fetch: environment.fetch,
    pageIsSecure: environment.pageIsSecure,
  }).pipe(Effect.flatMap((issuer) => beginSignInAt(issuer, returnTo, environment, request)))

/**
 * Start a sign-in at the already-discovered `issuer`: mint the PKCE pair and
 * the `state`, stash what the return leg needs, and yield the authorization URL
 * to navigate to.
 *
 * The issuer's FHIR base is the server the pending record and the
 * {@link Session} name. Only the endpoints discovered there ride the pending
 * record, so the return leg needs nothing more.
 *
 * `returnTo` is the in-app path the app wants to land on once signed in; it
 * rides the pending record and comes back as {@link Session.returnTo}, because
 * the registered redirect URI can't carry it. `undefined` when the app has
 * nowhere particular to go.
 *
 * `request` carries what the authorization request may add for this sign-in
 * alone, neither of which the return leg needs, so both stay out of the
 * pending record: `launch`, the SMART EHR launch the app was opened with, sent
 * so the server can tie the sign-in to it (without one, or with an empty one,
 * the request is a standalone launch); and `prompt`, sent to show the
 * server's limited page again (see {@link AuthorizationRequestExtras}).
 *
 * The pending record is written **before** the URL is yielded, so a caller
 * cannot navigate away from a flow whose verifier was never saved.
 */
const beginSignInAt = (
  issuer: SmartIssuer,
  returnTo: string | undefined,
  environment: SignInEnvironment,
  request: AuthorizationRequestExtras = {}
): Effect.Effect<string, PkceUnavailable | PendingRequestUnusable> =>
  Effect.gen(function* () {
    const { smartServer, endpoints } = issuer
    const codeVerifier = createCodeVerifier(environment.random)
    const state = createState(environment.random)
    const codeChallenge = yield* codeChallengeS256(codeVerifier, environment.subtle)

    yield* setStorageItem(
      environment.store,
      environment.pendingKey,
      serializePendingAuthorization({
        state,
        codeVerifier,
        serverUrl: smartServer.fhirBaseUrl,
        smartServer,
        tokenEndpoint: endpoints.tokenEndpoint,
        returnTo,
      })
    ).pipe(Effect.mapError(pendingRequestUnusableFrom))

    return authorizationRequestUrl(endpoints.authorizationEndpoint, {
      clientId: environment.clientId,
      redirectUri: environment.redirectUri,
      scope: environment.scope,
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
  /** The server the token was issued by, which requests must go to. */
  readonly serverUrl: string
  /** Which kind of server `serverUrl` is, and the FHIR base the token is for. */
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
  environment: SignInEnvironment
): Effect.Effect<Option.Option<Session>, SignInError> =>
  Effect.gen(function* () {
    if (!isAuthorizationResponse(search)) return Option.none()
    const stored = yield* takePendingRecord(environment)
    const returning = yield* authorizationRedirectOutcome(search, stored)
    if (Option.isNone(returning)) return Option.none()
    const { code, pending } = returning.value

    const response = yield* Effect.tryPromise({
      try: () =>
        environment.fetch(pending.tokenEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: tokenRequestBody({
            code,
            codeVerifier: pending.codeVerifier,
            redirectUri: environment.redirectUri,
            clientId: environment.clientId,
          }),
        }),
      catch: () =>
        new PendingRequestUnusable({
          reason: `Could not reach the token endpoint at ${pending.tokenEndpoint}.`,
        }),
    })
    const body = yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: () =>
        new PendingRequestUnusable({ reason: 'The token endpoint did not answer with JSON.' }),
    })
    const grant = yield* parseTokenResponse(body)
    return Option.some(sessionFrom(grant, pending))
  })

/**
 * Why a sign-in whose request `blocked` storage would not keep or give back
 * cannot be completed: the one wording for every sign-in request a page
 * retains across the redirect, this module's and an app's own.
 */
const pendingRequestUnusableFrom = (blocked: StorageBlocked): PendingRequestUnusable =>
  new PendingRequestUnusable({
    reason: Match.value(blocked.operation).pipe(
      Match.when(
        'write',
        () =>
          'This browser would not let the page remember the sign-in request ' +
          '(session storage is blocked), so it cannot be completed.'
      ),
      Match.whenOr(
        'read',
        'remove',
        () =>
          'This browser would not let the page use the sign-in request it kept ' +
          '(session storage is blocked), so it cannot be completed.'
      ),
      Match.exhaustive
    ),
  })

/**
 * Why a retained sign-in request that does not read as one cannot be
 * completed: the one wording for every sign-in request a page retains across
 * the redirect, this module's and an app's own.
 */
const pendingRequestUnrecognisedFromAnotherVersion = (): PendingRequestUnrecognised =>
  new PendingRequestUnrecognised({
    reason:
      'The sign-in in progress was started by a different version of this page. Sign in again.',
  })

/**
 * Take the pending record out of `environment`'s store: read it and drop it.
 * `None` only when there is none; a store that refuses to be read or written
 * fails with {@link PendingRequestUnusable}, and a record that does not read
 * as one with {@link PendingRequestUnrecognised}.
 */
const takePendingRecord = (
  environment: SignInEnvironment
): Effect.Effect<
  Option.Option<PendingAuthorization>,
  PendingRequestUnusable | PendingRequestUnrecognised
> =>
  Effect.gen(function* () {
    const stored = yield* takeStorageItem(environment.store, environment.pendingKey).pipe(
      Effect.mapError(pendingRequestUnusableFrom)
    )
    if (Option.isNone(stored)) return Option.none()
    const pending = parsePendingAuthorization(stored.value)
    if (Option.isNone(pending)) return yield* pendingRequestUnrecognisedFromAnotherVersion()
    return pending
  })

/**
 * Drop the sign-in `environment`'s store holds, without reading it: for a
 * page that completes some other flow on its return leg and must not leave
 * this one's record behind. A store that refuses removal fails with
 * {@link PendingRequestUnusable}.
 */
const forgetPendingSignIn = (
  environment: SignInEnvironment
): Effect.Effect<void, PendingRequestUnusable> =>
  removeStorageItem(environment.store, environment.pendingKey).pipe(
    Effect.mapError(pendingRequestUnusableFrom)
  )

/** The session a `grant` redeemed for the `pending` request becomes. */
const sessionFrom = (grant: AccessGrant, pending: PendingAuthorization): Session => ({
  accessToken: grant.accessToken,
  scope: grant.scope,
  serverUrl: pending.serverUrl,
  smartServer: pending.smartServer,
  expiresInSeconds: grant.expiresInSeconds,
  patient: grant.patient,
  returnTo: pending.returnTo,
})

export {
  PendingRequestUnrecognised,
  PendingRequestUnusable,
  beginSignIn,
  beginSignInAt,
  completeSignIn,
  forgetPendingSignIn,
  pendingRequestUnrecognisedFromAnotherVersion,
  pendingRequestUnusableFrom,
}
export type { AuthorizationRequestExtras, SignInError, PendingStore, SignInEnvironment, Session }
