import { HttpClient, HttpClientRequest } from '@effect/platform'
import { QueryCache, QueryClient, type Query } from '@tanstack/react-query'
import { trimTrailingSlashes } from '@wildflowerhealthio/fhir-r4/clients'
import { Duration, Effect, Layer, pipe } from 'effect'

import {
  sliceRuntimeLayer,
  type RouterContext,
  type RunAuthed,
  type RuntimeLayer,
} from '../router-context.ts'

/**
 * The SMART handshake resolved to the two facts a SMART app's HTTP layer
 * needs. A `SmartClient` is one.
 *
 * @remarks
 * Kept to primitives rather than the whole client, so the runtime below is
 * testable without a SMART handshake.
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

/** Whether `requestUrl` is the FHIR base `fhirBaseUrl` or a path under it, on its origin. */
const isUnderFhirBase = (requestUrl: string, fhirBaseUrl: string): boolean => {
  const request = URL.parse(requestUrl)
  const base = URL.parse(fhirBaseUrl)
  if (request === null || base === null) return false
  const basePath = trimTrailingSlashes(base.pathname)
  return (
    request.origin === base.origin &&
    (request.pathname === basePath || request.pathname.startsWith(`${basePath}/`))
  )
}

/**
 * Wrap an `HttpClient` layer so every request for the FHIR server is addressed
 * to it and carries the SMART bearer token, and no other request does.
 *
 * @remarks
 * Both halves are needed because a SMART app is served from its **own** origin
 * (its published site, or `http://localhost:{port}/` under its dev server), not
 * the FHIR server's. Left alone, the typed client's relative `/Patient…`
 * paths would resolve against the app's origin, and nothing else authenticates
 * the app cross-origin. So this app authenticates the way any third-party SMART
 * app does: with the token it was granted.
 *
 * One rule decides every request, whichever client made it (the typed
 * client's base-relative paths, or a `SmartClient.request` following a search
 * bundle's absolute `next` link):
 *
 * - A **relative** URL is resolved under `session.serverUrl` verbatim (trailing
 *   slashes trimmed) and carries the token: `/Patient` and `Patient` both
 *   become `{serverUrl}/Patient`.
 * - An **absolute** URL is left as it is. It carries the token only when it is
 *   the FHIR base or a path under it, on its origin; anywhere else it goes out
 *   bare, because the token was granted for this FHIR server alone and must
 *   never leave for a host that did not issue it. Prefixing an absolute URL
 *   would yield `http://host…http://…`, which `fetch` then resolves against the
 *   page origin — silent corruption rather than a failure.
 *
 * A session with no `accessToken` sets no header at all, rather than an empty
 * `Bearer `: an absent credential must read as absent.
 *
 * The transport is a parameter rather than baked in — the same shape as
 * `apps/launcher/launcher-web`'s `prependApiBaseUrl` — so what goes on the wire can
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
  const baseUrl = trimTrailingSlashes(session.serverUrl)
  const withToken = (
    request: HttpClientRequest.HttpClientRequest
  ): HttpClientRequest.HttpClientRequest =>
    accessToken === undefined ? request : HttpClientRequest.bearerToken(request, accessToken)
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      client.pipe(
        HttpClient.mapRequest((request) => {
          if (!hasAbsoluteScheme(request.url)) {
            return withToken(
              HttpClientRequest.updateUrl(
                request,
                (path) => `${baseUrl}/${path.replace(/^\/+/u, '')}`
              )
            )
          }
          return isUnderFhirBase(request.url, baseUrl) ? withToken(request) : request
        })
      )
    )
  ).pipe(Layer.provide(transport))
}

/** Options for {@link buildSmartQueryClient}. */
interface BuildSmartQueryClientOptions {
  /**
   * Called with the error and the query of every query that fails on the
   * client, the SMART handshake's included (`isSmartHandshakeQuery` tells it
   * apart); the app root reports it to its crash reporter here.
   */
  readonly onQueryError?: (
    queryError: unknown,
    failedQuery: Query<unknown, unknown, unknown>
  ) => void
}

/**
 * The `QueryClient` a SMART app runs on.
 *
 * @param options - Where the client's query failures are reported
 *
 * @remarks
 * In-memory only, no persister: what a SMART app reads is the data already on
 * its FHIR server, and the app is the surface that reads it — a second on-disk
 * copy of it, outside the store, buys nothing. `refetchOnWindowFocus` is off
 * because a SMART viewer has nothing that goes stale on focus.
 *
 * Exported so the app can build the client **once**, provide it at the tree root
 * (where {@link useSmartHandshake} runs the token exchange, before any router
 * context exists), and hand that same instance to {@link buildSmartRouterContext}
 * — one client for the handshake query and every app query alike.
 *
 * `onQueryError` is the query cache's `onError`, so it runs once per failed
 * query (after its retries), whichever component started it.
 */
const buildSmartQueryClient = (options: BuildSmartQueryClientOptions = {}): QueryClient =>
  new QueryClient({
    queryCache: new QueryCache({ onError: options.onQueryError }),
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
 * read `runAuthed` (importer tests) unchanged.
 *
 * `awaitAuthReady` resolves immediately: the shared shape carries it for host
 * apps whose route guards wait on a token that arrives asynchronously, and by
 * the time this runs the handshake is already complete. A consumer typically
 * reads only `runAuthed`, but the context has to be a faithful
 * `RouterContextWith<FhirR4ResourcesHttpApiClient>` for its `useRouteContext`
 * select to type.
 *
 * Nothing is re-sent on a 401: a bearer token is in hand before this is built,
 * so a 401 here is a real 401.
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

export {
  buildSmartQueryClient,
  buildSmartRouterContext,
  smartHttpClientLayer,
  type BuildSmartQueryClientOptions,
  type SmartSession,
}
