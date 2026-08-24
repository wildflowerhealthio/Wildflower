import { HttpClient, HttpClientRequest } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { Duration, Effect, Layer, pipe } from 'effect'

import {
  sliceRuntimeLayer,
  type RouterContext,
  type RunAuthed,
  type RuntimeLayer,
} from '../router-context.ts'

/**
 * The SMART handshake resolved to the two facts a self-hosted app's HTTP layer
 * needs.
 *
 * @remarks
 * Deliberately not a `fhirclient` `Client`: keeping the seam to primitives means
 * the runtime below is testable without a SMART handshake, and this module never
 * has to name a `fhirclient` type.
 */
interface SmartSession {
  /**
   * The FHIR server base the handshake named — an EHR launch's `iss`, or the
   * server a standalone launch was pointed at (e.g.
   * `https://launch.smarthealthit.org/v/r4/fhir`). Used verbatim as the base for
   * the typed client's relative paths; only trailing slashes are trimmed.
   */
  readonly serverUrl: string
  /** The bearer token from the token exchange, or `undefined` for an open server. */
  readonly accessToken: string | undefined
}

/** True when `url` leads with a scheme, per RFC 3986's `scheme` production. */
const hasAbsoluteScheme = (url: string): boolean => /^[a-z][a-z0-9+.-]*:/iu.test(url)

/**
 * Wrap an `HttpClient` layer so every relative request is addressed to the FHIR
 * server and carries the SMART bearer token.
 *
 * @remarks
 * Both halves are needed because a self-hosted app is served from its **own**
 * origin (`http://127.0.0.1:8091/` on device, an app's own site in the cloud),
 * not the FHIR server's. Left alone, the typed client's relative `/Patient…`
 * paths would resolve against the app's origin, and no cookie authenticates the
 * app cross-origin. So this app authenticates the way any third-party SMART app
 * does: with the token it was granted.
 *
 * The base is `session.serverUrl` verbatim — the typed client no longer bakes in
 * Wildflower's `/fhir-r4` mount path, so whatever server the handshake named is
 * the base, prepended as-is (trailing slashes trimmed). The typed client emits
 * base-relative paths like `/Patient`, which become `{serverUrl}/Patient`.
 *
 * The prefix is applied to *relative* URLs only. Prepending it to an
 * already-absolute URL yields `http://host…http://…`, which `fetch` then
 * resolves against the page origin — silent corruption rather than a failure.
 *
 * A session with no `accessToken` sets no header at all, rather than an empty
 * `Bearer `: an absent credential must read as absent.
 *
 * The token rides only the requests this layer *addressed* — i.e. the relative
 * paths the typed client emits, which the prefix sends to the FHIR server. An
 * already-absolute URL names an origin the session never granted anything for,
 * so it goes out bare: a credential must never leave for a host that did not
 * issue it.
 *
 * The transport is a parameter rather than baked in — the same shape as
 * `apps/wildflower-react`'s `prependApiBaseUrl` — so what goes on the wire can
 * be asserted against a stub instead of a real `fetch`.
 *
 * @param session - The FHIR base and bearer token from the SMART handshake
 * @param transport - The underlying `HttpClient` this wraps
 * @returns The wrapped layer
 */
const smartHttpClientLayer = (
  session: SmartSession,
  transport: Layer.Layer<HttpClient.HttpClient>
): Layer.Layer<HttpClient.HttpClient> => {
  const { accessToken } = session
  const baseUrl = session.serverUrl.replace(/\/+$/u, '')
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      client.pipe(
        HttpClient.mapRequest((request) => {
          if (hasAbsoluteScheme(request.url)) return request
          const addressed = HttpClientRequest.prependUrl(baseUrl)(request)
          return accessToken === undefined
            ? addressed
            : HttpClientRequest.bearerToken(accessToken)(addressed)
        })
      )
    )
  ).pipe(Layer.provide(transport))
}

/**
 * The `QueryClient` a self-hosted SMART app runs on.
 *
 * @remarks
 * In-memory only, no persister: what a self-hosted app reads is the data
 * already on the device, and the app is the surface that reads it — a second
 * on-disk copy of it, outside the store, buys nothing. `refetchOnWindowFocus` is
 * off because a self-hosted viewer has nothing that goes stale on focus.
 *
 * Exported so the app can build the client **once**, provide it at the tree root
 * (where {@link useSmartHandshake} runs the token exchange, before any router
 * context exists), and hand that same instance to {@link buildSmartRouterContext}
 * — one client for the handshake query and every app query alike.
 */
const buildSmartQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: pipe(5, Duration.minutes, Duration.toMillis),
        gcTime: pipe(30, Duration.minutes, Duration.toMillis),
        refetchOnWindowFocus: false,
      },
    },
  })

/**
 * The router context the app threads into its router, built from a completed
 * SMART handshake.
 *
 * @remarks
 * The transport is a parameter for the same reason
 * {@link smartHttpClientLayer}'s is: the app's whole tree can then be mounted
 * over a stub in a test. The app passes `FetchHttpClient.layer`.
 *
 * `queryClient` is a parameter (default a fresh {@link buildSmartQueryClient})
 * so the app can hand in the same client it provided at the tree root — the one
 * {@link useSmartHandshake} completed the exchange on — rather than the context
 * carrying a second, disconnected client. The default keeps callers that only
 * read `runAuthed` (importer/collector tests) unchanged.
 *
 * `awaitAuthReady` resolves immediately: the shared shape carries it for host
 * apps whose route guards wait on a token that arrives asynchronously, and by
 * the time this runs the handshake is already complete. A consumer typically
 * reads only `runAuthed`, but the context has to be a faithful
 * `RouterContextWith<FhirR4ResourcesHttpApiClient>` for its `useRouteContext`
 * select to type.
 *
 * There is no boot-race retry (the host app's `runAuthed` has one for the gap
 * before its `wf_auth` cookie lands). A bearer token is in hand before this is
 * built, so a 401 here is a real 401.
 *
 * @param session - The FHIR base and bearer token from the SMART handshake
 * @param transport - The underlying `HttpClient` every read goes out over
 * @param queryClient - The `QueryClient` the context carries; defaults to a
 *   fresh {@link buildSmartQueryClient}
 * @returns A router context ready for `createRouter`'s `context`
 */
const buildSmartRouterContext = (
  session: SmartSession,
  transport: Layer.Layer<HttpClient.HttpClient>,
  queryClient: QueryClient = buildSmartQueryClient()
): RouterContext => {
  const httpLayer = smartHttpClientLayer(session, transport)
  const runtimeLayer: RuntimeLayer = Layer.provideMerge(sliceRuntimeLayer, httpLayer)
  const runAuthed: RunAuthed = (effect, options) =>
    Effect.runPromise(Effect.provide(effect, runtimeLayer), options)
  return {
    queryClient,
    runAuthed,
    runtimeLayer,
    awaitAuthReady: () => Promise.resolve(),
  }
}

export { buildSmartQueryClient, buildSmartRouterContext, smartHttpClientLayer, type SmartSession }
