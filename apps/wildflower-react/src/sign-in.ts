/**
 * The web entry's OAuth client registration, and both halves of its sign-in.
 *
 * `main-web` signs in with the **SMART standalone launch** in
 * `gatekeeper-core/smart-client` — the same PKCE redirect flow the server-docs
 * console runs (`apps/wildflower-server-docs/src/main.ts`), against whichever
 * server `?server=` names. It is the fitting flow for this entry for the same
 * reason it fits the console: the page is cross-origin to its API server, so it
 * holds a bearer in memory, and the
 * reader is already looking at the browser that must approve the grant. The
 * device-code flow at `/gatekeeper/device-login` remains for the second-screen
 * case (and as the 401 fallback), but it is no longer how the landing page
 * signs in.
 *
 * What is left here is only what is this entry's own: the registered values
 * below, and the two thin wrappers that fold the flow's error channel into a
 * {@link SignInStep}. The impure wiring is `browserSignInEnvironment`'s and the
 * requested scopes are the standalone-launch vocabulary both seeded clients
 * share — neither is restated in this app.
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
  browserSignInEnvironment,
  completeSignIn,
  redirectUriForRoute,
  SERVER_QUERY_PARAM,
  standaloneLaunchScopeParameter,
  type Session,
  type SignInEnvironment,
  type SignInError,
  type SignInPage,
} from 'gatekeeper-core/smart-client'
import { AuthedUntil, type AuthState, HostAuthed, Unauthed } from 'react-kitchen-sink'

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
 * Resolved under the **served base** the caller passes to {@link
 * signInEnvironment} (the router's basepath), not the bare origin: on a subpath
 * deploy the route returns under `/app/` (or a PR preview's
 * `/staging/pr-<n>/app/`) the same way the router resolves it — see {@link
 * REGISTERED_REDIRECT_URI}.
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
 * row names `/app/home`, and the production copy is served under `/app/`, so its
 * base-aware derivation (see {@link POST_SIGN_IN_ROUTE}) yields exactly this
 * value and the sign-in returns silently. A PR preview served under
 * `/staging/pr-<n>/app/` derives its own `…/app/home` — correct for where it is,
 * but unregistered, so it completes through the consent prompt's "this app is
 * asking to return somewhere new" warning instead.
 */
const REGISTERED_REDIRECT_URI = 'https://wildflowerhealth.io/app/home'

/**
 * The `sessionStorage` key this entry's pending-authorization record lives at,
 * namespaced because this build shares both the flow and the
 * `wildflowerhealth.io` origin with the server-docs console. A key chosen
 * without the namespace would be one key for both, and one tab's return leg
 * could consume a record the other was waiting on.
 */
const PENDING_AUTHORIZATION_KEY = 'wildflower-react.pending-authorization'

/**
 * The `sessionStorage` key that carries where to land after a redeemed sign-in.
 *
 * The auth gate bounces an unauthed reader to the landing with a `?returnTo=`
 * naming the path they were headed for, but the SMART redirect returns to the
 * registered `/home` — which carries no query — so the parameter is gone by the
 * callback. Stashing it here is what carries it across the round trip. Like the
 * pending record it holds no credential, and it is namespaced for the same
 * reason: the server-docs console shares this origin.
 */
const RETURN_TO_KEY = 'wildflower-react.post-sign-in-return-to'

/** The query parameter the auth gate preserves the originally-requested path in. */
const RETURN_TO_PARAM = 'returnTo'

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
 * The served root of the copy at `href` — its origin plus `basePath` — named to
 * the server as gatekeeper-core's `CLIENT_BASE_URL_PARAM`. `undefined` for a
 * page not served over `http`/`https`, which the server would reject.
 *
 * @example clientBaseUrlFor('https://wildflowerhealth.io/app/settings', '/app/') // 'https://wildflowerhealth.io/app/'
 */
const clientBaseUrlFor = (href: string, basePath = '/'): string | undefined => {
  let here: URL
  try {
    here = new URL(href)
  } catch {
    return undefined
  }
  if (here.protocol !== 'http:' && here.protocol !== 'https:') return undefined
  return new URL(basePath.endsWith('/') ? basePath : `${basePath}/`, here.origin).href
}

/**
 * The impure edges — and this entry's registered values — the flow runs against.
 *
 * `basePath` is the served base (the router's basepath) the redirect returns
 * under; it defaults to the origin root. Both legs must pass the same value, so
 * the outbound `redirect_uri` and the one re-derived on the callback match: the
 * caller reads it at the app root, which is stable across the round trip (the
 * landing on the way out; the base the 404 redirect lands on when the code
 * comes back). See {@link POST_SIGN_IN_ROUTE}.
 */
const signInEnvironment = (page: SignInPage, basePath = '/'): SignInEnvironment => {
  const clientBaseUrl = clientBaseUrlFor(page.location.href, basePath)
  return browserSignInEnvironment(page, {
    clientId: CLIENT_ID,
    pendingKey: PENDING_AUTHORIZATION_KEY,
    scope: standaloneLaunchScopeParameter(),
    redirectUri:
      redirectUriForRoute(page.location.href, POST_SIGN_IN_ROUTE, basePath) ??
      REGISTERED_REDIRECT_URI,
    ...(clientBaseUrl === undefined ? {} : { clientBaseUrl }),
  })
}

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

/**
 * Return the store to `Unauthed` when the token's reported lifetime runs out.
 *
 * The bearer lives in page memory only and is never refreshed, so a lapsed
 * token would 401 every request it was attached to — silently. Flipping the
 * signal at `exp` (which also drops the bearer — see `makeBearerAuthStateStore`)
 * sends the next authed navigation back to the landing rather than into a
 * 401 loop. A response that reported no lifetime gets no timer, matching
 * {@link authStateForSession}'s `HostAuthed`.
 *
 * Mirrors `scheduleExpiryNotice` in `apps/wildflower-server-docs/src/main.ts`.
 * Returns a canceller: this entry signs in once per page load, so it is here for
 * symmetry and tests rather than a re-arm.
 */
const scheduleExpiry = (
  setAuthState: (signal: AuthState) => void,
  expiresInSeconds: number | undefined
): (() => void) => {
  if (expiresInSeconds === undefined) return () => {}
  const timer = setTimeout(
    () => {
      setAuthState(Unauthed())
    },
    Math.max(0, expiresInSeconds * 1000)
  )
  return () => {
    clearTimeout(timer)
  }
}

/**
 * Remember where to return after sign-in, reading the `?returnTo=` the auth gate
 * left on this page. Called just before leaving for the authorization server. A
 * page carrying no `returnTo` clears any stale value rather than leaving one a
 * later, unrelated sign-in would honour.
 */
const rememberReturnTo = (page: Pick<SignInPage, 'location' | 'sessionStorage'>): void => {
  const returnTo = new URL(page.location.href).searchParams.get(RETURN_TO_PARAM)
  try {
    if (returnTo === null || returnTo === '') page.sessionStorage.removeItem(RETURN_TO_KEY)
    else page.sessionStorage.setItem(RETURN_TO_KEY, returnTo)
  } catch {
    // A storage that refuses the write only means the reader lands on the
    // default `/home` — not a reason to fail the sign-in.
  }
}

/**
 * Take the remembered return path, removing it so it is honoured once. `null`
 * when none was stashed; the caller sanitises it before navigating.
 */
const takeReturnTo = (page: Pick<SignInPage, 'sessionStorage'>): string | null => {
  try {
    const stored = page.sessionStorage.getItem(RETURN_TO_KEY)
    page.sessionStorage.removeItem(RETURN_TO_KEY)
    return stored
  } catch {
    return null
  }
}

/**
 * The in-app URL to settle on after a redeemed sign-in: the (already sanitised)
 * `returnTo`, with no `?server=`.
 *
 * `?server=` only picks the server a sign-in goes to. Once the session is
 * redeemed, `main-web` takes the server from the session instead, so the
 * parameter comes out of the address bar. The root route only carries forward
 * a `server` that is already in the URL, so later navigations don't add it
 * back. `returnTo` may bring its own query and hash (the gate keeps the whole
 * path it bounced, including the `server` it carried), so only `server` is
 * removed from that query and the rest is kept. Any `?code=`/`?state=` from the
 * callback is dropped because the URL is rebuilt from the return path, not from
 * the address the browser arrived on.
 */
const postSignInUrl = (returnTo: string, origin: string): string => {
  const url = new URL(returnTo, origin)
  url.searchParams.delete(SERVER_QUERY_PARAM)
  return `${url.pathname}${url.search}${url.hash}`
}

export {
  authStateForSession,
  CLIENT_ID,
  clientBaseUrlFor,
  finishSignIn,
  PENDING_AUTHORIZATION_KEY,
  postSignInUrl,
  POST_SIGN_IN_ROUTE,
  REGISTERED_REDIRECT_URI,
  rememberReturnTo,
  RETURN_TO_KEY,
  RETURN_TO_PARAM,
  scheduleExpiry,
  signInEnvironment,
  startSignIn,
  takeReturnTo,
}
export type { SignInStep }
