/**
 * The two halves of a sign-in, each written as one `Effect` over an injected
 * environment: {@link beginSignIn} discovers the target's OAuth endpoints and
 * builds the URL to leave for, {@link completeSignIn} picks the flow back up
 * when the browser comes back and redeems the code.
 *
 * Neither navigates and neither touches the DOM — `beginSignIn` *yields* the
 * URL for the app to assign — so both are drivable from tests with a stub
 * fetch, fixed random bytes and a plain object standing in for
 * `sessionStorage`.
 *
 * Nothing here knows which app it is running for: the client id, the requested
 * scopes, the redirect URI and the `sessionStorage` key all arrive in the
 * {@link SignInEnvironment}, so two Wildflower pages on one origin cannot read
 * each other's pending record.
 *
 * ## The error channel
 *
 * Every way a sign-in can fail is a tagged error in {@link SignInError}, raised
 * where it happens: {@link PkceUnavailable} and {@link DiscoveryFailed} from the
 * modules that own those steps, {@link PendingRequestUnusable} from the storage
 * round trip here, {@link AuthorizationRejected} and
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
 * `makeEmbeddedAuthStateStore` follows for the same reason
 * (`slices/gatekeeper/docs/Auth Token Storage Explanation.md`). The only thing
 * that does reach `sessionStorage` is the pending record — no credential, and
 * deleted the instant the client returns, before the code is even redeemed.
 */

import { Data, Effect, Either, Option } from 'effect'

import {
  authorizationRedirectOutcome,
  authorizationRequestUrl,
  fhirAudienceFor,
  parsePendingAuthorization,
  parseTokenResponse,
  serializePendingAuthorization,
  tokenRequestBody,
  type AccessGrant,
  type AuthorizationRejected,
  type PendingAuthorization,
  type TokenExchangeFailed,
} from './authorization-flow.ts'
import { codeChallengeS256, createCodeVerifier, createState } from './pkce.ts'
import type { DigestSource, PkceUnavailable, RandomBytesSource } from './pkce.ts'
import { discoverSmartEndpoints, type DiscoveryFailed } from './smart-discovery.ts'

/**
 * Raised when the browser will not carry the pending request across the
 * redirect (Safari's private mode throws on `setItem`), or when the token
 * endpoint cannot be reached to redeem the code.
 */
class PendingRequestUnusable extends Data.TaggedError('PendingRequestUnusable')<{
  readonly reason: string
}> {}

/** Everything a sign-in can fail with, whichever half it fails in. */
type SignInError =
  | DiscoveryFailed
  | PkceUnavailable
  | PendingRequestUnusable
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
   * The `sessionStorage` key the pending record lives at. Namespace it with the
   * app's own name (`wildflower-server-docs.pending-authorization`): these pages
   * share an origin, so a key chosen here would be one key for all of them, and
   * one tab's return leg could consume a record another tab was waiting on.
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
  /**
   * The served root of the owner UI copy signing in, for a client that is one
   * (sent as `CLIENT_BASE_URL_PARAM` on the authorization request).
   */
  readonly clientBaseUrl?: string
}

/**
 * Start a sign-in against `serverUrl`: discover its endpoints, mint the PKCE
 * pair and the `state`, stash what the return leg needs, and yield the
 * authorization URL to navigate to.
 *
 * The pending record is written **before** the URL is yielded, so a caller
 * cannot navigate away from a flow whose verifier was never saved.
 */
const beginSignIn = (
  serverUrl: string,
  environment: SignInEnvironment
): Effect.Effect<string, SignInError> =>
  Effect.gen(function* () {
    const endpoints = yield* discoverSmartEndpoints(serverUrl, {
      fetch: environment.fetch,
      pageIsSecure: environment.pageIsSecure,
    })
    const codeVerifier = createCodeVerifier(environment.random)
    const state = createState(environment.random)
    const codeChallenge = yield* codeChallengeS256(codeVerifier, environment.subtle)

    yield* Effect.try({
      try: () =>
        environment.store.setItem(
          environment.pendingKey,
          serializePendingAuthorization({
            state,
            codeVerifier,
            serverUrl,
            tokenEndpoint: endpoints.tokenEndpoint,
          })
        ),
      catch: () =>
        new PendingRequestUnusable({
          reason:
            'This browser would not let the page remember the sign-in request ' +
            '(session storage is blocked), so it cannot be completed.',
        }),
    })

    return authorizationRequestUrl(endpoints.authorizationEndpoint, {
      clientId: environment.clientId,
      redirectUri: environment.redirectUri,
      scope: environment.scope,
      state,
      codeChallenge,
      audience: fhirAudienceFor(serverUrl),
      ...(environment.clientBaseUrl === undefined
        ? {}
        : { clientBaseUrl: environment.clientBaseUrl }),
    })
  })

/** A signed-in session: an in-memory token and what it is good for. */
interface Session {
  readonly accessToken: string
  /** The scopes the Owner actually granted. */
  readonly scope: string
  /** The server the token was issued by, which requests must go to. */
  readonly serverUrl: string
  readonly expiresInSeconds: number | undefined
}

/**
 * Finish a sign-in from the query string the client came back on: `None` when
 * this page load is not a return from the authorization server (the common
 * case), a {@link Session} when it is and the code redeemed.
 *
 * The pending record is single-use: it is dropped as soon as this page load is
 * known to be a return leg — before the code is redeemed, and on the rejected
 * paths too, so a discarded flow cannot leave a record behind that makes a later
 * stray `?code=` look legitimate.
 */
const completeSignIn = (
  search: string,
  environment: SignInEnvironment
): Effect.Effect<Option.Option<Session>, SignInError> =>
  Effect.gen(function* () {
    const stored = readPendingRecord(environment.store, environment.pendingKey)
    const outcome = authorizationRedirectOutcome(search, stored)
    const isReturnLeg = Either.isLeft(outcome) || Option.isSome(outcome.right)
    if (isReturnLeg)
      yield* Effect.sync(() => forgetPendingRecord(environment.store, environment.pendingKey))
    const returning = yield* outcome
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
    return Option.some(sessionFrom(grant, pending.serverUrl))
  })

/**
 * The pending record `store` holds at `key`, if any. A storage that refuses to
 * be read is indistinguishable from an empty one here, and neither is an error:
 * it only means this page load cannot be a return leg.
 */
const readPendingRecord = (
  store: PendingStore,
  key: string
): Option.Option<PendingAuthorization> => {
  try {
    return parsePendingAuthorization(store.getItem(key))
  } catch {
    return Option.none()
  }
}

/**
 * Drop the pending record. A storage that refuses removal cannot be helped, and
 * the flow is already past the point where the record mattered.
 */
const forgetPendingRecord = (store: PendingStore, key: string): void => {
  try {
    store.removeItem(key)
  } catch {
    // Deliberately ignored; see the doc comment.
  }
}

/** The session a `grant` for `serverUrl` becomes. */
const sessionFrom = (grant: AccessGrant, serverUrl: string): Session => ({
  accessToken: grant.accessToken,
  scope: grant.scope,
  serverUrl,
  expiresInSeconds: grant.expiresInSeconds,
})

export { PendingRequestUnusable, beginSignIn, completeSignIn }
export type { SignInError, PendingStore, SignInEnvironment, Session }
