/**
 * The two halves of a sign-in, each written as one function over an injected
 * environment: {@link beginSignIn} discovers the target's OAuth endpoints and
 * builds the URL to leave for, {@link completeSignIn} picks the flow back up
 * when the browser comes back and redeems the code.
 *
 * Neither navigates and neither touches the DOM — `beginSignIn` *returns* the
 * URL for `main.ts` to assign — so both are drivable from tests with a stub
 * fetch, fixed random bytes and a plain object standing in for
 * `sessionStorage`.
 *
 * ## Token custody
 *
 * The access token is returned to the caller and never written anywhere by this
 * module: no `localStorage`, no `sessionStorage`, no cookie. The console is a
 * public page and the token it obtains can be admin-capable, so it lives in one
 * `let` in `main.ts` and dies with the tab — the same in-memory-only policy
 * `makeEmbeddedAuthStateStore` follows for the same reason
 * (`slices/gatekeeper/docs/Auth Token Storage Explanation.md`). The only thing
 * that does reach `sessionStorage` is the pending record — no credential, and
 * deleted the instant the console returns, before the code is even redeemed.
 */

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
} from './authorization-flow.ts'
import { codeChallengeS256, createCodeVerifier, createState } from './pkce.ts'
import type { DigestSource, RandomBytesSource } from './pkce.ts'
import { CLIENT_ID, requestedScopeParameter } from './smart-client.ts'
import { discoverSmartEndpoints } from './smart-discovery.ts'

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

/** Where {@link beginSignIn} got to. */
export type BeginSignInResult =
  | { readonly kind: 'redirect'; readonly url: string }
  | { readonly kind: 'failed'; readonly problem: string }

/**
 * Start a sign-in against `serverUrl`: discover its endpoints, mint the PKCE
 * pair and the `state`, stash what the return leg needs, and hand back the
 * authorization URL to navigate to.
 *
 * The pending record is written **before** the URL is returned, so a caller
 * cannot navigate away from a flow whose verifier was never saved.
 */
export const beginSignIn = async (
  serverUrl: string,
  environment: SignInEnvironment
): Promise<BeginSignInResult> => {
  const discovery = await discoverSmartEndpoints(serverUrl, {
    fetch: environment.fetch,
    pageIsSecure: environment.pageIsSecure,
  })
  if (!discovery.ok) return { kind: 'failed', problem: discovery.problem }

  const codeVerifier = createCodeVerifier(environment.random)
  const state = createState(environment.random)
  let codeChallenge: string
  try {
    codeChallenge = await codeChallengeS256(codeVerifier, environment.subtle)
  } catch {
    return {
      kind: 'failed',
      problem: 'This browser cannot compute a PKCE challenge, so sign-in is not available here.',
    }
  }

  try {
    environment.store.setItem(
      PENDING_AUTHORIZATION_KEY,
      serializePendingAuthorization({
        state,
        codeVerifier,
        serverUrl,
        tokenEndpoint: discovery.endpoints.tokenEndpoint,
      })
    )
  } catch {
    return {
      kind: 'failed',
      problem:
        'This browser would not let the page remember the sign-in request ' +
        '(session storage is blocked), so it cannot be completed.',
    }
  }

  return {
    kind: 'redirect',
    url: authorizationRequestUrl(discovery.endpoints.authorizationEndpoint, {
      clientId: CLIENT_ID,
      redirectUri: environment.redirectUri,
      scope: requestedScopeParameter(),
      state,
      codeChallenge,
      audience: fhirAudienceFor(serverUrl),
    }),
  }
}

/** A signed-in session: an in-memory token and what it is good for. */
export interface Session {
  readonly accessToken: string
  /** The scopes the Owner actually granted. */
  readonly scope: string
  /** The server the token was issued by, which requests must go to. */
  readonly serverUrl: string
  readonly expiresInSeconds: number | undefined
}

/** Where {@link completeSignIn} got to. */
export type CompleteSignInResult =
  /** This page load was not a return from the authorization server. */
  | { readonly kind: 'none' }
  | { readonly kind: 'signed-in'; readonly session: Session }
  | { readonly kind: 'failed'; readonly problem: string }

/**
 * Finish a sign-in from the query string the console came back on.
 *
 * The pending record is removed as the **first** thing after it is read,
 * whatever happens next: it is single-use, and a stale one left behind would
 * make a later stray `?code=` look legitimate.
 */
export const completeSignIn = async (
  search: string,
  environment: SignInEnvironment
): Promise<CompleteSignInResult> => {
  let stored: string | null = null
  try {
    stored = environment.store.getItem(PENDING_AUTHORIZATION_KEY)
  } catch {
    stored = null
  }
  const outcome = authorizationRedirectOutcome(search, parsePendingAuthorization(stored))
  if (outcome.kind === 'none') return { kind: 'none' }
  try {
    environment.store.removeItem(PENDING_AUTHORIZATION_KEY)
  } catch {
    // A storage that refuses removal cannot be helped, and the flow is already
    // past the point where the record mattered.
  }
  if (outcome.kind === 'failed') return { kind: 'failed', problem: outcome.problem }

  let response: Response
  try {
    response = await environment.fetch(outcome.pending.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: tokenRequestBody({
        code: outcome.code,
        codeVerifier: outcome.pending.codeVerifier,
        redirectUri: environment.redirectUri,
        clientId: CLIENT_ID,
      }),
    })
  } catch {
    return {
      kind: 'failed',
      problem: `Could not reach the token endpoint at ${outcome.pending.tokenEndpoint}.`,
    }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { kind: 'failed', problem: 'The token endpoint did not answer with JSON.' }
  }
  const parsed = parseTokenResponse(body)
  if (!parsed.ok) return { kind: 'failed', problem: parsed.problem }
  return { kind: 'signed-in', session: sessionFrom(parsed.grant, outcome.pending.serverUrl) }
}

/** The session a `grant` for `serverUrl` becomes. */
const sessionFrom = (grant: AccessGrant, serverUrl: string): Session => ({
  accessToken: grant.accessToken,
  scope: grant.scope,
  serverUrl,
  expiresInSeconds: grant.expiresInSeconds,
})
