/**
 * The two halves of a sign-in, each written as one `Effect` over an injected
 * environment: {@link beginSignIn} discovers the target's OAuth endpoints and
 * builds the URL to leave for, {@link completeSignIn} picks the flow back up
 * when the browser comes back and redeems the code.
 *
 * Neither navigates and neither touches the DOM — `beginSignIn` *yields* the
 * URL for `main.ts` to assign — so both are drivable from tests with a stub
 * fetch, fixed random bytes and a plain object standing in for
 * `sessionStorage`.
 *
 * ## The error channel
 *
 * Every way a sign-in can fail is a tagged error in {@link SignInError}, raised
 * where it happens: {@link PkceUnavailable} and {@link DiscoveryFailed} from the
 * modules that own those steps, {@link PendingRequestUnusable} from the storage
 * round trip here, {@link AuthorizationRejected} and
 * {@link TokenExchangeFailed} from the flow's pure validation. Nothing throws
 * and nothing returns an ad-hoc `{ ok }` union; `main.ts` runs the Effect at the
 * one boundary and renders `error.reason` on the header bar's status line.
 *
 * ## Token custody
 *
 * The access token is the Effect's success value and is never written anywhere
 * by this module: no `localStorage`, no `sessionStorage`, no cookie. The console
 * is a public page and the token it obtains can be admin-capable, so it lives in
 * one `let` in `main.ts` and dies with the tab — the same in-memory-only policy
 * `makeEmbeddedAuthStateStore` follows for the same reason
 * (`slices/gatekeeper/docs/Auth Token Storage Explanation.md`). The only thing
 * that does reach `sessionStorage` is the pending record — no credential, and
 * deleted the instant the console returns, before the code is even redeemed.
 */

import { Data, Effect, Either, Option } from 'effect'

import {
  authorizationRedirectOutcome,
  authorizationRequestUrl,
  fhirAudienceFor,
  parsePendingAuthorization,
  parseTokenResponse,
  PENDING_AUTHORIZATION_KEY,
  serializePendingAuthorization,
  tokenRequestBody,
  type AccessGrant,
  type AuthorizationRejected,
  type PendingAuthorization,
  type TokenExchangeFailed,
} from './authorization-flow.ts'
import { codeChallengeS256, createCodeVerifier, createState } from './pkce.ts'
import type { DigestSource, PkceUnavailable, RandomBytesSource } from './pkce.ts'
import { CLIENT_ID, requestedScopeParameter } from './smart-client.ts'
import { discoverSmartEndpoints, type DiscoveryFailed } from './smart-discovery.ts'

/**
 * Raised when the browser will not carry the pending request across the
 * redirect (Safari's private mode throws on `setItem`), or when the token
 * endpoint cannot be reached to redeem the code.
 */
export class PendingRequestUnusable extends Data.TaggedError('PendingRequestUnusable')<{
  readonly reason: string
}> {}

/** Everything a sign-in can fail with, whichever half it fails in. */
export type SignInError =
  | DiscoveryFailed
  | PkceUnavailable
  | PendingRequestUnusable
  | AuthorizationRejected
  | TokenExchangeFailed

/** The `sessionStorage`-shaped slice the flow needs. */
export interface PendingStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Everything impure the flow depends on, supplied by the caller. */
export interface SignInEnvironment {
  readonly fetch: typeof globalThis.fetch
  readonly random: RandomBytesSource
  readonly subtle: DigestSource
  readonly store: PendingStore
  /** The redirect URI to send, which must be the client's registered one. */
  readonly redirectUri: string
  /** Whether the console itself is on a secure page (an `https:` document). */
  readonly pageIsSecure: boolean
}

/**
 * Start a sign-in against `serverUrl`: discover its endpoints, mint the PKCE
 * pair and the `state`, stash what the return leg needs, and yield the
 * authorization URL to navigate to.
 *
 * The pending record is written **before** the URL is yielded, so a caller
 * cannot navigate away from a flow whose verifier was never saved.
 */
export const beginSignIn = (
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
          PENDING_AUTHORIZATION_KEY,
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
      clientId: CLIENT_ID,
      redirectUri: environment.redirectUri,
      scope: requestedScopeParameter(),
      state,
      codeChallenge,
      audience: fhirAudienceFor(serverUrl),
    })
  })

/** A signed-in session: an in-memory token and what it is good for. */
export interface Session {
  readonly accessToken: string
  /** The scopes the Owner actually granted. */
  readonly scope: string
  /** The server the token was issued by, which requests must go to. */
  readonly serverUrl: string
  readonly expiresInSeconds: number | undefined
}

/**
 * Finish a sign-in from the query string the console came back on: `None` when
 * this page load is not a return from the authorization server (the common
 * case), a {@link Session} when it is and the code redeemed.
 *
 * The pending record is single-use: it is dropped as soon as this page load is
 * known to be a return leg — before the code is redeemed, and on the rejected
 * paths too, so a discarded flow cannot leave a record behind that makes a later
 * stray `?code=` look legitimate.
 */
export const completeSignIn = (
  search: string,
  environment: SignInEnvironment
): Effect.Effect<Option.Option<Session>, SignInError> =>
  Effect.gen(function* () {
    const stored = readPendingRecord(environment.store)
    const outcome = authorizationRedirectOutcome(search, stored)
    const isReturnLeg = Either.isLeft(outcome) || Option.isSome(outcome.right)
    if (isReturnLeg) yield* Effect.sync(() => forgetPendingRecord(environment.store))
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
            clientId: CLIENT_ID,
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
 * The pending record `store` holds, if any. A storage that refuses to be read
 * is indistinguishable from an empty one here, and neither is an error: it only
 * means this page load cannot be a return leg.
 */
const readPendingRecord = (store: PendingStore): Option.Option<PendingAuthorization> => {
  try {
    return parsePendingAuthorization(store.getItem(PENDING_AUTHORIZATION_KEY))
  } catch {
    return Option.none()
  }
}

/**
 * Drop the pending record. A storage that refuses removal cannot be helped, and
 * the flow is already past the point where the record mattered.
 */
const forgetPendingRecord = (store: PendingStore): void => {
  try {
    store.removeItem(PENDING_AUTHORIZATION_KEY)
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
