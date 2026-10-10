/**
 * The web entry's OAuth client registration, and both halves of its sign-in.
 *
 * `main-web` signs in with the **SMART standalone launch** in
 * `gatekeeper-core/smart-client` — the same PKCE redirect flow the server-docs
 * console runs (`apps/server-docs-web/src/main.ts`), against whichever
 * server `?server=` names. Opened with a SMART launch instead (`?iss=`, with
 * the EHR's `launch` when there is one, as the base opens a server's
 * launcher), it signs in to the server `iss` names, carrying that `launch`
 * (see {@link EhrLaunch}). It is the fitting flow for this entry for the same
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
 * record, which carries no credential — and which is also how the auth gate's
 * `?returnTo=` survives the round trip (see {@link returnToOnPage}).
 */

import {
  beginSignIn,
  browserSignInEnvironment,
  completeSignIn,
  parsePendingAuthorization,
  redirectUriForRoute,
  SERVER_QUERY_PARAM,
  standaloneLaunchScopeParameter,
  type Session,
  type SignInEnvironment,
  type SignInError,
  type SignInPage,
} from '@wildflowerhealthio/gatekeeper-core/smart-client'
import {
  AuthedUntil,
  type AuthState,
  HostAuthed,
  Unauthed,
} from '@wildflowerhealthio/react-kitchen-sink'
import { Effect, Option } from 'effect'

import { ServerKind } from './session/server-kind.ts'

/**
 * The `client_id` the web entry authorizes as: a random id
 * (`openssl rand -hex 16`), seeded by gatekeeper migration
 * `0012_seed_wildflower_react_client` and re-keyed by
 * `0026_rekey_launcher_client`. The migrations are the authority and this is
 * the browser-side reading of them: a
 * value that drifts from the row fails the flow at `/oauth/authorize` rather
 * than degrading quietly.
 *
 * Deliberately **not** `FIRST_PARTY_CLIENT_ID` (`wildflower-host`). The
 * first-party client is seeded from code with no redirect URIs and is the one
 * client `/oauth/authorize` refuses to trust on first use, so it cannot carry an
 * authorization-code redirect from a browser page at all — see 0012's header.
 */
const CLIENT_ID = '03a513940b52f8c2649a5366d1a26d19'

/**
 * The route a sign-in returns to: the app root. A fixed route rather than the
 * page's own directory (what the server-docs console derives): this is a
 * single-page app on browser history, so the directory is whichever section the
 * reader was in when they clicked sign in, and only one of those could ever be
 * the registered value. The root is also the one address every static host
 * serves as a real file, so the callback needs no 404 redirect to reach the app.
 * Where the reader was headed rides the pending record instead (see
 * {@link returnToOnPage}).
 *
 * `main-web.tsx` redeems the code **before** it mounts the router, then settles
 * on that return path, which is usually behind the `_auth` gate — a router
 * mounted first would find the store still unauthed and bounce to the landing
 * while the token was in flight.
 *
 * Resolved under the **served base** the caller passes to {@link
 * signInEnvironment} (the router's basepath), not the bare origin: on a subpath
 * deploy the route returns to `/launcher/` (or a PR preview's
 * `/staging/pr-<n>/launcher/`) the same way the router resolves it — see {@link
 * REGISTERED_REDIRECT_URI}.
 */
const POST_SIGN_IN_ROUTE = '/'

/**
 * The redirect URI of the **published** web build, and the sole entry of the
 * seeded row (`0026_rekey_launcher_client`). Every other
 * copy derives its own from where it is served; this is the fallback for a page
 * whose address a sign-in must not return to at all, which is unreachable from a
 * browser actually running this build.
 *
 * It MUST equal the row's entry, which is matched by exact string equality. The
 * row names `/launcher/`, and the production copy is served under `/launcher/`,
 * so its base-aware derivation (see {@link POST_SIGN_IN_ROUTE}) yields exactly
 * this value and the sign-in returns silently. A PR preview served under
 * `/staging/pr-<n>/launcher/` derives its own `…/launcher/` — correct for where
 * it is, but unregistered, so it completes through the consent prompt's "this
 * app is asking to return somewhere new" warning instead.
 */
const REGISTERED_REDIRECT_URI = 'https://wildflowerhealth.io/launcher/'

/**
 * The `sessionStorage` key this entry's pending-authorization record lives at,
 * namespaced because this build shares both the flow and the
 * `wildflowerhealth.io` origin with the server-docs console. A key chosen
 * without the namespace would be one key for both, and one tab's return leg
 * could consume a record the other was waiting on.
 */
const PENDING_AUTHORIZATION_KEY = 'launcher-web.pending-authorization'

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
 * The impure edges — and this entry's registered values — the flow runs against.
 *
 * `basePath` is the served base (the router's basepath) the redirect returns
 * under; it defaults to the origin root. Both legs must pass the same value, so
 * the outbound `redirect_uri` and the one re-derived on the callback match: the
 * caller reads it at the app root, which is stable across the round trip (the
 * landing on the way out; the base the 404 redirect lands on when the code
 * comes back). See {@link POST_SIGN_IN_ROUTE}.
 */
const signInEnvironment = (page: SignInPage, basePath = '/'): SignInEnvironment =>
  browserSignInEnvironment(page, {
    clientId: CLIENT_ID,
    pendingKey: PENDING_AUTHORIZATION_KEY,
    scope: standaloneLaunchScopeParameter(),
    redirectUri:
      redirectUriForRoute(page.location.href, POST_SIGN_IN_ROUTE, basePath) ??
      REGISTERED_REDIRECT_URI,
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
 * caller to navigate to. `returnTo` (raw, from {@link returnToOnPage}) rides the
 * pending record and comes back as the redeemed session's `returnTo`. `launch`
 * is the {@link EhrLaunch}'s token when the sign-in is to the server the page
 * was launched against; without it the sign-in is a standalone launch. The
 * pending record is written before the URL comes back, so a caller cannot leave
 * on a flow whose verifier was never saved.
 *
 * The FHIR base it discovers at is found by asking: a Wildflower server's
 * `{serverUrl}/fhir-r4` first, then, only if that answers 404, `serverUrl`
 * itself as a plain SMART server's FHIR base (`beginSignIn`).
 */
const startSignIn = (
  serverUrl: string,
  returnTo: string | undefined,
  environment: SignInEnvironment,
  launch?: string
): Promise<SignInStep<string>> => runStep(beginSignIn(serverUrl, returnTo, environment, launch))

/**
 * The SMART EHR launch this page load was opened with — by the base opening a
 * server's launcher at `?iss=…&launch=…` — and the server its `iss` names, in
 * the canonical form `?server=` holds. `main-web`'s boot reads it
 * (`web-entry.ts`'s `ehrLaunchIn`) into an {@link UnsentEhrLaunch}, and the
 * landing signs in to `serverUrl` with `launch` on arrival. Gatekeeper accepts
 * a launch once and only for a few minutes, so it rides one sign-in and no
 * more.
 */
interface EhrLaunch {
  readonly serverUrl: string
  readonly launch: string
}

/**
 * The page load's {@link EhrLaunch} until a sign-in takes it. `main-web`'s
 * boot makes one per page load, with {@link unsentEhrLaunch}, and the landing
 * takes the launch from it, so the launch goes out on the first sign-in to its
 * server and on no later one, however often the landing remounts: gatekeeper
 * accepts a launch once.
 */
interface UnsentEhrLaunch {
  /**
   * The launch, when it is for `serverUrl` and no sign-in has taken it yet,
   * and `undefined` otherwise. Taking it leaves nothing to take.
   */
  readonly takeFor: (serverUrl: string) => string | undefined
}

/** An {@link UnsentEhrLaunch} holding `ehrLaunch`. */
const unsentEhrLaunch = (ehrLaunch: EhrLaunch): UnsentEhrLaunch => {
  let unsent: EhrLaunch | undefined = ehrLaunch
  return {
    takeFor: (serverUrl) => {
      if (unsent?.serverUrl !== serverUrl) return undefined
      const { launch } = unsent
      unsent = undefined
      return launch
    },
  }
}

/**
 * A sign-in that failed on its way back, before the page's tree existed: why,
 * and the server it was signing in to, when this tab's pending record still
 * named one. `main-web`'s boot points `?server=` back at that server, so the
 * landing offers it again; it is also the server the landing's Local Network
 * Access hint is about.
 */
interface SignInProblem {
  readonly reason: string
  readonly serverUrl: string | undefined
}

/** The outcome of {@link finishSignIn}: a {@link SignInStep} whose failure names its server. */
type FinishedSignIn =
  | { readonly tag: 'Ok'; readonly value: Option.Option<Session> }
  | { readonly tag: 'Failed'; readonly problem: SignInProblem }

/**
 * The server the pending record in `environment`'s store names, if any. An
 * unreadable store is treated as an empty one, as `completeSignIn` treats it:
 * either way there is no server to name.
 */
const pendingServerUrlIn = (environment: SignInEnvironment): string | undefined => {
  try {
    return Option.getOrUndefined(
      Option.map(
        parsePendingAuthorization(environment.store.getItem(environment.pendingKey)),
        (pending) => pending.serverUrl
      )
    )
  } catch {
    return undefined
  }
}

/**
 * Finish a sign-in from the query string this page load arrived on: `None` when
 * the load is not a return from the authorization server (the common case), a
 * {@link Session} when it is and the code redeemed, and a {@link SignInProblem}
 * naming the server when it failed. The server is read before `completeSignIn`
 * runs, since it drops the pending record as soon as it knows this is a return
 * leg.
 */
const finishSignIn = async (
  search: string,
  environment: SignInEnvironment
): Promise<FinishedSignIn> => {
  const serverUrl = pendingServerUrlIn(environment)
  const step = await runStep(completeSignIn(search, environment))
  return step.tag === 'Ok' ? step : { tag: 'Failed', problem: { reason: step.reason, serverUrl } }
}

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
 * The {@link ServerKind} a redeemed `session` signed in to: a Wildflower server
 * when discovery found its configuration under `/fhir-r4`, otherwise a plain
 * SMART server, with the FHIR base the token is for and the patient the token
 * response put in context.
 */
const serverKindForSession = (session: Session): ServerKind => {
  const { smartServer } = session
  return smartServer._tag === 'WildflowerServer'
    ? ServerKind.Wildflower()
    : ServerKind.PlainSmart({ fhirBaseUrl: smartServer.fhirBaseUrl, patient: session.patient })
}

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
 * Mirrors `scheduleExpiryNotice` in `apps/server-docs-web/src/main.ts`.
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
 * The `?returnTo=` the auth gate left on the page at `href` — where the reader
 * was headed when it bounced them to the landing — or `undefined` when it names
 * none. Raw: the SMART redirect returns to the app root with no query, so this
 * is handed to {@link startSignIn} to ride the pending record, and `main-web`
 * sanitises what comes back before navigating.
 */
const returnToOnPage = (href: string): string | undefined => {
  const returnTo = new URL(href).searchParams.get(RETURN_TO_PARAM)
  return returnTo === null || returnTo === '' ? undefined : returnTo
}

/**
 * The in-app URL to settle on after a redeemed sign-in: the (already sanitised)
 * `returnTo`, with no `?server=`.
 *
 * `?server=` only picks the server a sign-in goes to. Once the session is
 * redeemed, `main-web` remembers the session's server in the tab's
 * `sessionStorage` instead (see `web-entry.ts`'s `chosenServerUrl`), so the
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
  finishSignIn,
  PENDING_AUTHORIZATION_KEY,
  postSignInUrl,
  POST_SIGN_IN_ROUTE,
  REGISTERED_REDIRECT_URI,
  RETURN_TO_PARAM,
  returnToOnPage,
  scheduleExpiry,
  serverKindForSession,
  signInEnvironment,
  startSignIn,
  unsentEhrLaunch,
}
export type { EhrLaunch, FinishedSignIn, SignInProblem, SignInStep, UnsentEhrLaunch }
