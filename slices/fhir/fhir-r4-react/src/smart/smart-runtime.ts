import { HttpClient } from '@effect/platform'
import { QueryCache, QueryClient, type Query } from '@tanstack/react-query'
import { Duration, Effect, Layer, pipe } from 'effect'

import {
  sliceRuntimeLayer,
  type RouterContext,
  type RunAuthed,
  type RuntimeLayer,
} from '../router-context.ts'
import { addressedTo } from './smart-client.ts'
import type { SmartConnection } from './smart-connection.ts'

/**
 * Wrap an `HttpClient` layer so every request for the FHIR server is addressed
 * to it and carries the SMART bearer token, and no other request does: the
 * rule `SmartClient` follows ({@link addressedTo}), for a client that is not a
 * `SmartClient`, such as the typed `FhirR4ResourcesHttpApiClient`.
 *
 * @remarks
 * The transport is a parameter rather than baked in — the same shape as
 * `apps/launcher/launcher-web`'s `prependApiBaseUrl` — so what goes on the wire can
 * be asserted against a stub instead of a real `fetch`.
 *
 * @param target - The FHIR base and bearer token from the SMART handshake
 * @param transport - The underlying `HttpClient` this wraps
 * @returns The wrapped layer
 */
const smartHttpClientLayer = (
  target: Pick<SmartConnection, 'fhirBaseUrl' | 'accessToken'>,
  transport: Layer.Layer<HttpClient.HttpClient>
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, addressedTo(target))).pipe(
    Layer.provide(transport)
  )

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
 * @param connection - The server the SMART handshake connected to
 * @param transport - The underlying `HttpClient` every read goes out over
 * @param queryClient - The `QueryClient` the context carries; defaults to a
 *   fresh {@link buildSmartQueryClient}
 * @returns A router context ready for `createRouter`'s `context`
 */
const buildSmartRouterContext = (
  connection: SmartConnection,
  transport: Layer.Layer<HttpClient.HttpClient>,
  queryClient: QueryClient = buildSmartQueryClient()
): RouterContext => {
  const httpLayer = smartHttpClientLayer(connection, transport)
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
}
