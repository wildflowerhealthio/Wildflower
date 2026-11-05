import { FetchHttpClient, HttpClient } from '@effect/platform'
import { QueryCache, QueryClient, type Query } from '@tanstack/react-query'
import type { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import type { BaseRouterContext } from '@wildflowerhealthio/shared-structures-react'
import { Duration, Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { sliceRuntimeLayer } from '../router-context.ts'
import { addressedTo, SmartClient } from './smart-client.ts'
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
 * (where `useSmartHandshake` runs the token exchange, before any router
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
 * What every read and write over a completed SMART handshake is run with:
 * the `SmartClient` the readers here use, the typed
 * `FhirR4ResourcesHttpApiClient` the writers use, and the addressed
 * `HttpClient` under both.
 */
type SmartServices = SmartClient | FhirR4ResourcesHttpApiClient

/** The layer that provides {@link SmartServices} over the page's `HttpClient`. */
type SmartRuntimeLayer = BaseRouterContext.RuntimeLayerWith<SmartServices>

/** Run an Effect needing any of {@link SmartServices} at a Promise boundary. */
type RunSmart = BaseRouterContext.RunAuthedWith<SmartServices>

/**
 * The one runtime a completed SMART handshake hands the app:
 * `SmartHandshakeGate` builds it from the connection, provides it to the
 * tree (`useRunSmart`), and hands it to the app, whose router context
 * carries the same runtime ({@link buildSmartRouterContext}). Its services
 * are built once, on the first run, and live until it is released.
 */
interface SmartRuntime {
  /** The server the handshake connected to. */
  readonly connection: SmartConnection
  /** Every SMART service, over one `HttpClient`. */
  readonly runtimeLayer: SmartRuntimeLayer
  /** Run an Effect over the services {@link SmartRuntime.runtimeLayer} built. */
  readonly runSmart: RunSmart
  /**
   * Release the services built so far, closing their scope; a run after this
   * builds them afresh.
   */
  readonly release: () => Promise<void>
}

/**
 * The {@link SmartRuntime} for `connection`: `SmartClient.layer` and the typed
 * `FhirR4ResourcesHttpApiClient` over the same `transport`, each addressing
 * its requests by the rule `SmartClient` follows.
 *
 * @param connection - The server the SMART handshake connected to
 * @param transport - The `HttpClient` every request goes out over:
 *   `FetchHttpClient.layer` in the app (the default), a stub in a test
 *
 * @remarks
 * The services are a `ManagedRuntime` over the layer, built on the first run
 * and shared by every run after it, until `release` disposes it and puts an
 * unbuilt one in its place. Nothing is re-sent on a
 * 401: a bearer token is in hand before this is built, so a 401 here is a
 * real 401.
 */
const smartRuntimeFor = (
  connection: SmartConnection,
  transport: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer
): SmartRuntime => {
  const runtimeLayer: SmartRuntimeLayer = Layer.mergeAll(
    SmartClient.layer(connection),
    Layer.provideMerge(sliceRuntimeLayer, smartHttpClientLayer(connection, transport))
  ).pipe(Layer.provide(transport))
  let managedRuntime = ManagedRuntime.make(runtimeLayer)
  const runSmart: RunSmart = (effect, options) => managedRuntime.runPromise(effect, options)
  const release = (): Promise<void> => {
    const releasedRuntime = managedRuntime
    managedRuntime = ManagedRuntime.make(runtimeLayer)
    return releasedRuntime.dispose()
  }
  return { connection, runtimeLayer, runSmart, release }
}

/**
 * The router context a routed SMART app threads into its router: the page's
 * query cache, the server the handshake connected to, and the runtime the
 * handshake built, as `runAuthed` and `runtimeLayer`.
 */
interface SmartRouterContext extends BaseRouterContext.RouterContextWith<SmartServices> {
  /** The server the handshake connected to. */
  readonly connection: SmartConnection
}

/**
 * The router context over `runtime`, the one `SmartHandshakeGate` built.
 *
 * @param runtime - The runtime the completed SMART handshake handed the app
 * @param queryClient - The `QueryClient` the context carries; the app passes
 *   the one it provided at the tree root, where `useSmartHandshake` completed
 *   the exchange, so the handshake and every app query share one cache
 * @returns A router context ready for `createRouter`'s `context`
 *
 * @remarks
 * `awaitAuthReady` resolves immediately: the shared shape carries it for host
 * apps whose route guards wait on a token that arrives asynchronously, and by
 * the time this runs the handshake is already complete.
 */
const buildSmartRouterContext = (
  runtime: SmartRuntime,
  queryClient: QueryClient = buildSmartQueryClient()
): SmartRouterContext => ({
  queryClient,
  connection: runtime.connection,
  runAuthed: runtime.runSmart,
  runtimeLayer: runtime.runtimeLayer,
  awaitAuthReady: () => Promise.resolve(),
})

export {
  buildSmartQueryClient,
  buildSmartRouterContext,
  smartHttpClientLayer,
  smartRuntimeFor,
  type BuildSmartQueryClientOptions,
  type RunSmart,
  type SmartRouterContext,
  type SmartRuntime,
  type SmartRuntimeLayer,
  type SmartServices,
}
