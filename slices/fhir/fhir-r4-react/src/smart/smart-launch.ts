import {
  arrivingSmartLaunchFrom,
  AuthorizationRejected,
  beginSignIn,
  browserSignInEnvironment,
  completeSignIn,
  createState,
  PendingRequestUnusable,
  searchWithoutAuthorizationResponse,
  SMART_LAUNCH_PARAMS,
  type ArrivingSmartLaunch,
  type PendingStore,
  type SignInEnvironment,
  type SignInError,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { trimTrailingSlashes } from '@wildflowerhealthio/fhir-r4/clients'
import { Effect, Either, Match, Option, Schema } from 'effect'

import { smartClientFor, type SmartClient } from './smart-client.ts'

/**
 * Configuration for a SMART App Launch: the app's registered client, where the
 * authorization server sends the browser back to, and the FHIR server
 * (`iss`, the "issuer") to sign in to.
 */
interface SmartLaunchConfig {
  readonly clientId: string
  readonly scope: string
  readonly redirectUri: string
  /** The FHIR server base to sign in to: an EHR launch's `iss`, or a picked server. */
  readonly iss: string
}

/**
 * The `sessionStorage` key `authorization-core`'s sign-in keeps its pending
 * record at, for every SMART app on this package. `sessionStorage` is per tab,
 * so it is one key for the one sign-in a tab can be in.
 */
const PENDING_AUTHORIZATION_KEY = 'fhir-r4-react.pending-authorization'

/**
 * The `sessionStorage` key the {@link PendingConnection} this tab started
 * lives at until the redirect target completes it.
 */
const PENDING_CONNECTION_KEY = 'fhir-r4-react.pending-connection'

/**
 * A SMART sign-in in progress: the registration its return leg redeems the
 * code as. `authorization-core` keeps the rest (the PKCE verifier, the `state`,
 * the token endpoint) in its own pending record.
 */
const PendingSignIn = Schema.TaggedStruct('PendingSignIn', {
  clientId: Schema.String,
  scope: Schema.String,
  redirectUri: Schema.String,
})
type PendingSignIn = Schema.Schema.Type<typeof PendingSignIn>

/**
 * A connection to an open server in progress: the server, and the `state`
 * the redirect target must come back with.
 */
const PendingOpenServer = Schema.TaggedStruct('PendingOpenServer', {
  state: Schema.String,
  serverUrl: Schema.String,
})
type PendingOpenServer = Schema.Schema.Type<typeof PendingOpenServer>

/**
 * What the redirect target needs to finish the connection this tab started,
 * carried across the redirect in `sessionStorage`. It holds no credential.
 */
const PendingConnection = Schema.Union(PendingSignIn, PendingOpenServer)
type PendingConnection = Schema.Schema.Type<typeof PendingConnection>

const PendingConnectionJson = Schema.parseJson(PendingConnection)
const encodePendingConnection = Schema.encodeSync(PendingConnectionJson)
const decodePendingConnection = Schema.decodeUnknownOption(PendingConnectionJson)

/** The sign-in environment for `pendingSignIn`'s registration, wired to this page. */
const signInEnvironmentFor = (pendingSignIn: PendingSignIn): SignInEnvironment =>
  browserSignInEnvironment(window, {
    clientId: pendingSignIn.clientId,
    pendingKey: PENDING_AUTHORIZATION_KEY,
    scope: pendingSignIn.scope,
    redirectUri: pendingSignIn.redirectUri,
  })

/** Keep `pendingConnection` for the redirect target, before the page leaves. */
const rememberPendingConnection = (
  pendingConnection: PendingConnection
): Effect.Effect<void, PendingRequestUnusable> =>
  Effect.try({
    try: () =>
      window.sessionStorage.setItem(
        PENDING_CONNECTION_KEY,
        encodePendingConnection(pendingConnection)
      ),
    catch: () =>
      new PendingRequestUnusable({
        reason:
          'This browser would not let the page remember the connection ' +
          '(session storage is blocked), so it cannot be completed.',
      }),
  })

/**
 * Take the {@link PendingConnection} out of `store`: it is single-use, so it
 * is dropped as it is read. A storage that refuses to be read is treated as an
 * empty one, as `authorization-core`'s `completeSignIn` treats its own record:
 * either way there is no connection to complete.
 */
const takePendingConnection = (store: PendingStore): Option.Option<PendingConnection> => {
  try {
    const stored = store.getItem(PENDING_CONNECTION_KEY)
    store.removeItem(PENDING_CONNECTION_KEY)
    return stored === null ? Option.none() : decodePendingConnection(stored)
  } catch {
    return Option.none()
  }
}

/**
 * Run a connection step at the page's Promise boundary: its value, or a
 * rejection with an `Error` whose message is the failure's reader-facing
 * `reason`, the tagged failure as its `cause`.
 */
const runConnectionStep = async <A>(step: Effect.Effect<A, SignInError>): Promise<A> =>
  Either.getOrThrowWith(
    await Effect.runPromise(Effect.either(step)),
    (failure) => new Error(failure.reason, { cause: failure })
  )

/**
 * Begin the SMART App Launch against `config.iss`: discover its endpoints, keep
 * what the redirect target needs, and send the browser to the authorization
 * endpoint. `launch` is the EHR's launch token for an EHR launch, and
 * `undefined` for a standalone launch.
 *
 * @remarks
 * `authorization-core`'s `beginSignIn` discovers the endpoints from
 * `{iss}/.well-known/smart-configuration` and accepts the authorization
 * endpoint only when `endpointUrlFrom` does for this page: a `javascript:`
 * URL, one carrying userinfo or a fragment, and plain http off loopback from an
 * https page are each refused. Then the promise rejects with discovery's
 * reason and the page stays where it is.
 */
const authorizeSmartLaunch = (
  config: SmartLaunchConfig,
  launch: string | undefined
): Promise<void> =>
  runConnectionStep(
    Effect.gen(function* () {
      const pendingSignIn = PendingSignIn.make({
        clientId: config.clientId,
        scope: config.scope,
        redirectUri: config.redirectUri,
      })
      const authorizeUrl = yield* beginSignIn(
        trimTrailingSlashes(config.iss),
        undefined,
        signInEnvironmentFor(pendingSignIn),
        launch
      )
      yield* rememberPendingConnection(pendingSignIn)
      window.location.assign(authorizeUrl)
    })
  )

/**
 * Configuration for connecting to an **open** FHIR server — one whose
 * `.well-known/smart-configuration` names no authorization endpoint (or serves
 * no config at all). There is no OAuth handshake: the page goes straight to
 * the redirect target, which `readySmartClient` completes into a client with
 * no access token.
 */
interface OpenServerConfig {
  /** The FHIR server base to connect to, used with no `Authorization` header. */
  readonly fhirServiceUrl: string
  readonly redirectUri: string
}

/**
 * Begin an open-server connection: keep the server for the redirect target
 * and send the browser straight there, carrying a fresh `state`, so the page
 * usually navigates away. The URL is the app's own redirect target, not one a
 * server advertised.
 */
const authorizeOpenServer = (config: OpenServerConfig): Promise<void> =>
  runConnectionStep(
    Effect.gen(function* () {
      const state = createState(window.crypto)
      yield* rememberPendingConnection(
        PendingOpenServer.make({ state, serverUrl: trimTrailingSlashes(config.fhirServiceUrl) })
      )
      const redirectTarget = new URL(config.redirectUri)
      redirectTarget.searchParams.set('state', state)
      window.location.assign(redirectTarget.href)
    })
  )

/** Redeem the code `search` carries for the sign-in `pendingSignIn` started. */
const redeemSignIn = (
  search: string,
  pendingSignIn: PendingSignIn
): Effect.Effect<SmartClient, SignInError> => {
  const environment = signInEnvironmentFor(pendingSignIn)
  return completeSignIn(search, environment).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new AuthorizationRejected({
              reason:
                'The authorization server sent this page back without an authorization code. ' +
                'Connect again.',
            })
          ),
        onSome: (session) => Effect.succeed(smartClientFor(session, environment.fetch)),
      })
    )
  )
}

/** The open server `pendingOpenServer` names, once `search` comes back with its `state`. */
const connectOpenServer = (
  search: string,
  pendingOpenServer: PendingOpenServer
): Effect.Effect<SmartClient, AuthorizationRejected> =>
  new URLSearchParams(search).get('state') === pendingOpenServer.state
    ? Effect.succeed(
        smartClientFor(
          { serverUrl: pendingOpenServer.serverUrl, accessToken: undefined, patient: undefined },
          (...request) => window.fetch(...request)
        )
      )
    : Effect.fail(
        new AuthorizationRejected({
          reason: 'The connection came back with the wrong state parameter, so it was discarded.',
        })
      )

/**
 * Take the authorization response out of the address bar, keeping the rest of
 * the URL and the history entry's state (a router's history tags it).
 */
const scrubAuthorizationResponse = (): void => {
  const { pathname, search, hash } = window.location
  window.history.replaceState(
    window.history.state,
    '',
    `${pathname}${searchWithoutAuthorizationResponse(search)}${hash}`
  )
}

/**
 * Complete the connection on the redirect target: redeem the code a SMART
 * sign-in came back with, or accept an open server's return, and resolve to a
 * ready {@link SmartClient}.
 *
 * @remarks
 * The pending connection is single-use: it is taken before the code is
 * redeemed, so a second completion (a reload, a remount) finds nothing to
 * complete and rejects, as a page with no connection in progress does. The
 * callback's `code` and `state` leave the address bar once the connection
 * settles, whichever way.
 */
const readySmartClient = (): Promise<SmartClient> =>
  runConnectionStep(
    Effect.gen(function* () {
      const { search } = window.location
      const pendingConnection = takePendingConnection(window.sessionStorage)
      if (Option.isNone(pendingConnection)) {
        return yield* new AuthorizationRejected({
          reason: 'This page has no connection in progress to complete. Connect again.',
        })
      }
      return yield* Match.value(pendingConnection.value).pipe(
        Match.tagsExhaustive({
          PendingSignIn: (pendingSignIn) => redeemSignIn(search, pendingSignIn),
          PendingOpenServer: (pendingOpenServer) => connectOpenServer(search, pendingOpenServer),
        })
      )
    }).pipe(Effect.ensuring(Effect.sync(scrubAuthorizationResponse)))
  )

/**
 * Whether `search` is a SMART/OAuth redirect the app should complete with
 * {@link readySmartClient} (rather than showing the connect menu).
 *
 * @remarks
 * The app root serves a fresh visit (no query → show the connect menu), a
 * launch it was opened to start ({@link arrivingSmartLaunchFrom}), and the OAuth
 * redirect target (has a callback → run the app). `code` marks a SMART return
 * and `state` an open-server one; either means there is a handshake to
 * complete.
 *
 * An `error=…` return is excluded deliberately: an OAuth error still carries
 * `state`, so without this the app would try to complete a handshake that failed
 * (a denied or expired authorization). Excluding it routes those back to the
 * connect menu to retry instead.
 *
 * `search` is a parameter (default `window.location.search`) so the decision can
 * be exercised without a window — the same transport-is-a-parameter style as the
 * rest of `smart/`.
 */
const shouldCompleteSmartLaunch = (search: string = window.location.search): boolean => {
  const params = new URLSearchParams(search)
  if (params.has('error')) return false
  return params.has('code') || params.has('state')
}

/**
 * The OAuth redirect URI for a SMART app, from the URL of any of its pages:
 * the app's served directory, `servedDirectory`, on `href`'s origin,
 * without the page's query or fragment. Without `servedDirectory` it is
 * `href`'s own directory (`new URL('.', href)`), right for an app whose every
 * page sits at its root.
 *
 * @param href - The page's URL.
 * @param servedDirectory - The directory the app is served from, as an
 *   absolute, slash-suffixed path (a routed app's basepath, e.g. `/pr-7/`). A
 *   routed app passes it, since a launch can open one of its deep routes
 *   (`/patients/123/today?iss=…`), whose own directory is no registered
 *   redirect URI.
 *
 * @remarks
 * The app root, which serves `index.html`, is the one redirect target for every
 * way in: a launch it was opened to start ({@link arrivingSmartLaunchFrom}), a
 * standalone launch from the connect menu, and a failed launch sent back with
 * `launchErrorRedirect`. It is
 * the page that completes the handshake ({@link readySmartClient}) and the page
 * that can show a failure, so a launch always returns there. Every such page
 * derives the same value, and the value is the same on the way out and on the
 * callback whatever query the page carries.
 *
 * Derived from the page URL rather than configured, so the bundle works at
 * whatever origin and path it is served from. It is not `authorization-core`'s
 * `redirectUriForPage`: there is no plaintext screen, because the registered
 * client's redirect URIs decide where a launch may return, and any userinfo the
 * page URL carries is kept.
 */
const appRootRedirectUri = (href: string, servedDirectory = '.'): string =>
  new URL(servedDirectory, href).href

export {
  appRootRedirectUri,
  /**
   * Re-exported from `authorization-core/smart-client`, like `normalizeServerUrl`:
   * the launch a page's URL asks it to start, which the app root reads to
   * authorize a launch rather than show the connect menu. The pages that sign
   * in with `authorization-core` read launches the same way without depending on
   * this package.
   */
  arrivingSmartLaunchFrom,
  authorizeOpenServer,
  authorizeSmartLaunch,
  PENDING_CONNECTION_KEY,
  readySmartClient,
  shouldCompleteSmartLaunch,
  /** Re-exported with `arrivingSmartLaunchFrom`: the parameters it reads a launch from. */
  SMART_LAUNCH_PARAMS,
  type ArrivingSmartLaunch,
  type OpenServerConfig,
  type SmartLaunchConfig,
}
