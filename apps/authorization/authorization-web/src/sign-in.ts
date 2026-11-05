/**
 * Wildflower Authorization's sign-in: the SMART standalone launch in
 * `authorization-core/smart-client`, the PKCE redirect flow the launcher and
 * the server-docs console run, against the server `?iss=` names.
 *
 * The app manages a Wildflower server only, so both halves read the server's
 * SMART configuration for what it needs beyond the OAuth endpoints: a sign-in
 * starts only once the document lists the `wildflower-server` capability, and a
 * redeemed one becomes a {@link ServerSession} only with the
 * `wildflower_authorization_api` the document advertises.
 *
 * ## Token custody
 *
 * The access token is never written anywhere by this module. It lives in the
 * {@link ServerSession} the page holds in memory and dies with the tab, the
 * policy `slices/authorization/docs/Auth Token Storage Explanation.md` sets for
 * a bearer a public page holds. Only the retained sign-in request, which carries no
 * credential, reaches `sessionStorage`, under the app's own key.
 */

import type { HttpClient } from '@effect/platform'
import {
  beginSignIn,
  BrowserSignIn,
  completeSignIn,
  discoverSmartServer,
  peekRetainedSignInRequest,
  redirectUriForRoute,
  type ClientRegistration,
  type DiscoveryFailed,
  type Session,
  type SignInError,
  type PageSecurity,
  type SignInServices,
  type SignInWindow,
  type DiscoveredSmartServer,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { Data, Effect, type Layer, Option } from 'effect'

import {
  AUTHORIZATION_CLIENT_ID,
  AUTHORIZATION_SCOPE,
  RETAINED_SIGN_IN_REQUEST_KEY,
  REGISTERED_REDIRECT_URI,
} from './config.ts'

/**
 * Raised when the chosen server is not one this app can manage: its SMART
 * configuration doesn't list the `wildflower-server` capability, or doesn't
 * advertise the authorization API.
 */
class NotAWildflowerServer extends Data.TaggedError('NotAWildflowerServer')<{
  readonly reason: string
}> {}

/** What the app says when the chosen server isn't a Wildflower server. */
const NOT_A_WILDFLOWER_SERVER =
  "This isn't a Wildflower server. Wildflower Authorization manages what a Wildflower " +
  'server has authorized; enter the address of one.'

/** What the app says when a Wildflower server doesn't advertise its authorization API. */
const NO_AUTHORIZATION_API =
  'This Wildflower server does not advertise its authorization API ' +
  '(`wildflower_authorization_api`), so its access cannot be managed here.'

/**
 * The page's session with the server it manages: the server, the base of its
 * authorization API as its SMART configuration advertises it, and the bearer
 * the sign-in redeemed.
 */
interface ServerSession {
  /** The server's SMART issuer, which `?iss=` names. */
  readonly serverUrl: string
  /** The `wildflower_authorization_api` the server advertises, e.g. `https://ruth.wildflowerhealth.io/authorization/`. */
  readonly authorizationApiUrl: string
  readonly accessToken: string
  /**
   * The in-app path the sign-in was started to reach, unsanitised; see
   * {@link inAppReturnPath}. `undefined` when none was named.
   */
  readonly returnTo: string | undefined
}

/**
 * The outcome of a sign-in step that can fail with something worth showing the
 * reader: every failure carries a `reason` written for a reader.
 */
type SignInStep<A> =
  | { readonly tag: 'Ok'; readonly value: A }
  | { readonly tag: 'Failed'; readonly reason: string }

/**
 * A sign-in that failed on its way back, before the page's tree existed: why,
 * and the server it was to, when this tab's retained sign-in request still named one.
 * The landing points `?iss=` back at that server and shows the reason.
 */
interface SignInProblem {
  readonly reason: string
  readonly serverUrl: string | undefined
}

/** The outcome of {@link finishSignIn}. */
type FinishedSignIn =
  | { readonly tag: 'Ok'; readonly value: Option.Option<ServerSession> }
  | { readonly tag: 'Failed'; readonly problem: SignInProblem }

/**
 * The app's registration, returning to the page at `href`.
 *
 * `basePath` is the served directory (the router's basepath) a sign-in
 * returns to: the app root, `/` on the published site's own origin.
 * Both legs pass the same value, so the outbound `redirect_uri` and the one
 * re-derived on the callback match.
 */
const signInRegistration = (href: string, basePath: string): ClientRegistration => ({
  clientId: AUTHORIZATION_CLIENT_ID,
  scope: AUTHORIZATION_SCOPE,
  redirectUri: redirectUriForRoute(href, '/', basePath) ?? REGISTERED_REDIRECT_URI,
})

/** The sign-in services of `page`, its retained sign-in request kept at the app's own key. */
const signInLayer = (page: SignInWindow): Layer.Layer<SignInServices> =>
  BrowserSignIn.layer(page, RETAINED_SIGN_IN_REQUEST_KEY)

/**
 * The base of the authorization API the `discovered` server advertises, when it is a
 * Wildflower server that advertises one.
 */
const authorizationApiOf = (
  discovered: DiscoveredSmartServer
): Effect.Effect<string, NotAWildflowerServer> =>
  discovered.smartServer._tag === 'WildflowerServer'
    ? Effect.orElseFail(
        discovered.wildflowerAuthorizationApi,
        () => new NotAWildflowerServer({ reason: NO_AUTHORIZATION_API })
      )
    : Effect.fail(new NotAWildflowerServer({ reason: NOT_A_WILDFLOWER_SERVER }))

/** The authorization API of the Wildflower server at `serverUrl`, from its SMART configuration. */
const discoverAuthorizationApi = (
  serverUrl: string
): Effect.Effect<
  string,
  DiscoveryFailed | NotAWildflowerServer,
  HttpClient.HttpClient | PageSecurity
> => discoverSmartServer(serverUrl).pipe(Effect.flatMap(authorizationApiOf))

/** A sign-in Effect's outcome as a {@link SignInStep}: its failure channel folded in. */
const stepOf = <A, R>(
  effect: Effect.Effect<A, SignInError | NotAWildflowerServer, R>
): Effect.Effect<SignInStep<A>, never, R> =>
  Effect.match(effect, {
    onSuccess: (value): SignInStep<A> => ({ tag: 'Ok', value }),
    onFailure: (error): SignInStep<A> => ({ tag: 'Failed', reason: error.reason }),
  })

/**
 * Start a sign-in to `serverUrl` from `page`, served under `basePath`,
 * yielding the authorization URL to leave for, or why it can't start: a server
 * that isn't a Wildflower server is refused here, before the reader is sent
 * anywhere. `options.returnTo` rides the retained sign-in request and comes back on the
 * {@link ServerSession}.
 */
const startSignIn = (
  serverUrl: string,
  page: SignInWindow,
  basePath: string,
  options: { readonly returnTo?: string | undefined } = {}
): Promise<SignInStep<string>> =>
  stepOf(
    discoverAuthorizationApi(serverUrl).pipe(
      Effect.zipRight(
        beginSignIn(serverUrl, signInRegistration(page.location.href, basePath), options)
      )
    )
  ).pipe(Effect.provide(signInLayer(page)), Effect.runPromise)

/** The {@link ServerSession} a redeemed `session` becomes, once its server's API is found. */
const serverSessionFor = (
  session: Session
): Effect.Effect<
  ServerSession,
  DiscoveryFailed | NotAWildflowerServer,
  HttpClient.HttpClient | PageSecurity
> =>
  discoverAuthorizationApi(session.smartServer.fhirBaseUrl).pipe(
    Effect.map((authorizationApiUrl) => ({
      serverUrl: session.smartServer.fhirBaseUrl,
      authorizationApiUrl,
      accessToken: session.accessToken,
      returnTo: session.returnTo,
    }))
  )

/**
 * Finish a sign-in from the query string this page load arrived on: `None`
 * when the load is not a return from the authorization server, a
 * {@link ServerSession} when it is and the code redeemed, and a
 * {@link SignInProblem} naming the server when it failed. The server is read
 * before `completeSignIn` runs, since it drops the retained sign-in request as soon as it
 * knows this is a return leg.
 */
const finishSignIn = (
  search: string,
  page: SignInWindow,
  basePath: string
): Promise<FinishedSignIn> =>
  Effect.gen(function* () {
    // An unreadable store names no server, as `completeSignIn` treats it as
    // an empty one.
    const serverUrl = yield* peekRetainedSignInRequest.pipe(
      Effect.map((retained) =>
        retained.pipe(
          Option.map((request) => request.smartServer.fhirBaseUrl),
          Option.getOrUndefined
        )
      ),
      Effect.orElseSucceed(() => undefined)
    )
    const step = yield* stepOf(
      completeSignIn(search, signInRegistration(page.location.href, basePath)).pipe(
        Effect.flatMap((redeemed) =>
          Option.match(redeemed, {
            onNone: () => Effect.succeedNone,
            onSome: (session) => Effect.asSome(serverSessionFor(session)),
          })
        )
      )
    )
    return step.tag === 'Ok'
      ? step
      : ({ tag: 'Failed', problem: { reason: step.reason, serverUrl } } as const)
  }).pipe(Effect.provide(signInLayer(page)), Effect.runPromise)

/**
 * The in-app path to settle on after a sign-in: `returnTo` when it is a
 * same-origin absolute path, and the app root otherwise. `returnTo` rode a
 * query parameter's worth of trust (the retained sign-in request), so a
 * protocol-relative (`//evil.test`) or backslash-smuggled (`/\evil.test`)
 * form, which a browser resolves to another origin, falls back to the root.
 */
const inAppReturnPath = (returnTo: string | undefined): string =>
  returnTo === undefined ||
  !returnTo.startsWith('/') ||
  returnTo.startsWith('//') ||
  returnTo.startsWith('/\\')
    ? '/'
    : returnTo

export { finishSignIn, inAppReturnPath, NOT_A_WILDFLOWER_SERVER, NotAWildflowerServer, startSignIn }
export type { FinishedSignIn, ServerSession, SignInProblem, SignInStep }
