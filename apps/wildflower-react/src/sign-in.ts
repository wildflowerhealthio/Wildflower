/**
 * The web entry's OAuth client registration, and both halves of its sign-in.
 *
 * `main-web` signs in with the **SMART standalone launch** in
 * `gatekeeper-core/smart-client` — the same PKCE redirect flow the server-docs
 * console runs (`apps/wildflower-server-docs/src/main.ts`), against whichever
 * server `?server=` names. It is the fitting flow for this entry for the same
 * reason it fits the console: the page is cross-origin to its API server, so it
 * holds a bearer in memory rather than riding an `HttpOnly` cookie, and the
 * reader is already looking at the browser that must approve the grant. The
 * device-code flow at `/gatekeeper/device-login` remains for the second-screen
 * case (and as the 401 fallback), but it is no longer how the landing page
 * signs in.
 *
 * Nothing here navigates or touches the DOM: {@link startSignIn} yields
 * the URL to leave for and {@link finishSignIn} reads a query string, so
 * both are drivable from a test with a stub `Window`. The one Effect boundary is
 * inside each of them — every failure arrives as a reader-facing `reason` on a
 * {@link SignInStep}, never as a rejection.
 *
 * ## Token custody
 *
 * The access token is never written anywhere by this module. It goes into the
 * in-memory `BearerAuthStateStore` and dies with the tab, the policy
 * `slices/gatekeeper/docs/Auth Token Storage Explanation.md` sets for a bearer a
 * public page holds. The only thing that reaches `sessionStorage` is the pending
 * record, which carries no credential.
 */

import type { Option } from 'effect'
import { Effect } from 'effect'
import {
  beginSignIn,
  completeSignIn,
  redirectUriForRoute,
  type DigestSource,
  type PendingStore,
  type RandomBytesSource,
  type Session,
  type SignInEnvironment,
  type SignInError,
} from 'gatekeeper-core/smart-client'
import { AuthedUntil, type AuthState, HostAuthed } from 'react-kitchen-sink'

/**
 * The `client_id` the web entry authorizes as, seeded by
 * `slices/gatekeeper/gatekeeper-rust/migrations/0012_seed_wildflower_react_client`.
 * That migration is the authority and this is the browser-side reading of it: a
 * value that drifts from the row fails the flow at `/oauth/authorize` rather
 * than degrading quietly.
 *
 * Deliberately **not** `FIRST_PARTY_CLIENT_ID` (`wildflower-host`). The
 * first-party client is seeded from code with no redirect URIs and is the one
 * client `/oauth/authorize` refuses to trust on first use, so it cannot carry an
 * authorization-code redirect from a browser page at all — see 0012's header.
 */
const CLIENT_ID = 'wildflower-react'

/**
 * The route a sign-in returns to. A fixed route rather than the page's own
 * directory (what the server-docs console derives): this is a single-page app on
 * browser history, so the directory is whichever section the reader was in when
 * they clicked sign in, and only one of those could ever be the registered
 * value.
 *
 * It is behind the `_auth` gate, which is why `main-web.tsx` redeems the code
 * **before** it mounts the router — a router mounted first would find the store
 * still unauthed and bounce to `/` while the token was in flight.
 *
 * Resolved against the **origin**, which is the app's own base today: the router
 * is built with a plain `createBrowserHistory()` and its routes are
 * root-absolute. A copy published under a subpath would need a router basepath
 * before this route resolved there at all, and this derivation would have to
 * follow it — see {@link REGISTERED_REDIRECT_URI}.
 */
const POST_SIGN_IN_ROUTE = '/home'

/**
 * The redirect URI of the **published** web build, and the sole entry of the
 * seeded row (`0012_seed_wildflower_react_client`). Every other copy derives its
 * own from where it is served; this is the fallback for a page whose address a
 * sign-in must not return to at all, which is unreachable from a browser
 * actually running this build.
 *
 * It MUST equal the row's entry, which is matched by exact string equality. The
 * row names `/app/home`, so the published copy is one served under `/app/` —
 * an arrangement the router does not yet support (see
 * {@link POST_SIGN_IN_ROUTE}). Until it does, a copy served there derives
 * `<origin>/home`, which the server treats as an unregistered redirect: the
 * sign-in still completes, but through the consent prompt's "this app is asking
 * to return somewhere new" warning rather than silently.
 */
const REGISTERED_REDIRECT_URI = 'https://wildflowerhealth.io/app/home'

/**
 * The scopes the web entry asks for: the whole ceiling the seeded row allows,
 * identical to the server-docs console's set.
 *
 * Asking wide is deliberate and is the same argument 0007 and 0012 make.
 * `allowed_scopes` is only the ceiling on what may be *requested*; the Owner's
 * consent step is where the grant is actually narrowed. The owner UI drives
 * every slice surface, so it cannot know in advance which one the reader will
 * open, and requesting less would 403 surfaces the reader is entitled to.
 */
const REQUESTED_SCOPES: readonly string[] = [
  'openid',
  'profile',
  'fhirUser',
  'launch',
  'launch/patient',
  'offline_access',
  'wildflower/launch',
  'system/*.cruds',
  'wildflower/*.cruds',
]

/** The space-delimited `scope` parameter form of {@link REQUESTED_SCOPES}. */
const requestedScopeParameter = (): string => REQUESTED_SCOPES.join(' ')

/**
 * The `sessionStorage` key this entry's pending-authorization record lives at,
 * namespaced because this build shares both the flow and the
 * `wildflowerhealth.io` origin with the server-docs console. A key chosen
 * without the namespace would be one key for both, and one tab's return leg
 * could consume a record the other was waiting on.
 */
const PENDING_AUTHORIZATION_KEY = 'wildflower-react.pending-authorization'

/**
 * The outcome of a sign-in step that can fail with something worth showing the
 * reader. Both halves of the flow fail with a {@link SignInError}, and every
 * variant carries a `reason` written for a reader, so one shape renders them
 * all and neither half needs a `catch`.
 */
type SignInStep<A> =
  | { readonly tag: 'Ok'; readonly value: A }
  | { readonly tag: 'Failed'; readonly reason: string }

/**
 * The slice of `window` a sign-in is built from. A real `Window` satisfies it
 * structurally, so the caller passes `window`; declaring the slice rather than
 * taking `Window` is what lets a test drive the flow from a plain object — no
 * jsdom navigation, and no cast to fake a global.
 */
interface SignInPage {
  readonly fetch: typeof globalThis.fetch
  readonly crypto: RandomBytesSource & { readonly subtle: DigestSource }
  readonly sessionStorage: PendingStore
  readonly location: { readonly href: string; readonly protocol: string }
}

/** The impure edges — and the app-specific values — the flow runs against. */
const signInEnvironment = (page: SignInPage): SignInEnvironment => ({
  // Called as a method so a real `Window.fetch` keeps its receiver; an unbound
  // reference throws `Illegal invocation` in a browser.
  fetch: (...args) => page.fetch(...args),
  random: page.crypto,
  subtle: page.crypto.subtle,
  store: page.sessionStorage,
  pendingKey: PENDING_AUTHORIZATION_KEY,
  clientId: CLIENT_ID,
  scope: requestedScopeParameter(),
  redirectUri:
    redirectUriForRoute(page.location.href, POST_SIGN_IN_ROUTE) ?? REGISTERED_REDIRECT_URI,
  pageIsSecure: page.location.protocol === 'https:',
})

/** Fold a sign-in Effect's failure channel into a {@link SignInStep}. */
const runStep = <A>(effect: Effect.Effect<A, SignInError>): Promise<SignInStep<A>> =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onSuccess: (value): SignInStep<A> => ({ tag: 'Ok', value }),
        onFailure: (error: SignInError): SignInStep<A> => ({ tag: 'Failed', reason: error.reason }),
      })
    )
  )

/**
 * Start a sign-in against `serverUrl`, yielding the authorization URL for the
 * caller to navigate to. The pending record is written before the URL comes
 * back, so a caller cannot leave on a flow whose verifier was never saved.
 */
const startSignIn = (
  serverUrl: string,
  environment: SignInEnvironment
): Promise<SignInStep<string>> => runStep(beginSignIn(serverUrl, environment))

/**
 * Finish a sign-in from the query string this page load arrived on: `None` when
 * the load is not a return from the authorization server (the common case), a
 * {@link Session} when it is and the code redeemed.
 */
const finishSignIn = (
  search: string,
  environment: SignInEnvironment
): Promise<SignInStep<Option.Option<Session>>> => runStep(completeSignIn(search, environment))

/**
 * The auth signal a redeemed `session` publishes, given the current time in unix
 * seconds.
 *
 * A reported lifetime becomes `AuthedUntil`, so `isFreshlyAuthed` can tell a
 * lapsed session from a live one. A response that reports none (RFC 6749 leaves
 * `expires_in` optional; gatekeeper always sends it) becomes `HostAuthed` — the
 * signal for "authed, with no expiry the page knows" — rather than an
 * `AuthedUntil` carrying an invented `exp`, which would claim a freshness
 * nothing established.
 */
const authStateForSession = (session: Session, nowSeconds: number): AuthState =>
  session.expiresInSeconds === undefined
    ? HostAuthed()
    : AuthedUntil({ exp: nowSeconds + session.expiresInSeconds })

export {
  authStateForSession,
  CLIENT_ID,
  finishSignIn,
  PENDING_AUTHORIZATION_KEY,
  POST_SIGN_IN_ROUTE,
  REGISTERED_REDIRECT_URI,
  REQUESTED_SCOPES,
  requestedScopeParameter,
  signInEnvironment,
  startSignIn,
}
export type { SignInPage, SignInStep }
