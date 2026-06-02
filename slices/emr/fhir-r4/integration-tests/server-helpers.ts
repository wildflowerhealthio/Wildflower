import type { HttpClient } from '@effect/platform'
import { FetchHttpClient, HttpApiBuilder, HttpApiClient, HttpServer } from '@effect/platform'
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, type Store } from '@livestore/livestore'
import { Effect, Layer } from 'effect'

import { EmrStore, schema } from 'emr-core/livestore'
import { Origin } from 'navigation-core'

import { FhirPublicApi, FhirResourcesApi } from '../src/http-api-definition/index.ts'
import {
  FhirPublicApiHandlersLive,
  FhirResourcesApiLive,
} from '../src/http-api-implementation/index.ts'

const ORIGIN = 'http://localhost:8787'

type FetchLayer = Layer.Layer<HttpClient.HttpClient | FetchHttpClient.Fetch>

const fetchLayerFor = (handler: (req: Request) => Promise<Response>): FetchLayer => {
  const fakeFetch: typeof fetch = (input, init) => {
    if (input instanceof Request) {
      return handler(input)
    } else {
      return handler(new Request(input, init))
    }
  }
  // `FetchHttpClient.Fetch` is read from the fiber context AT REQUEST TIME
  // (`context.unsafeMap.get(fetchTagKey) ?? globalThis.fetch`), so we need
  // the Fetch tag IN the fiber context — not as a Layer dependency. Merging
  // both services into one layer ensures `Effect.provide(...)` adds Fetch
  // alongside HttpClient.
  return Layer.merge(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fakeFetch))
}

const makeResourcesClientEffect = HttpApiClient.make(FhirResourcesApi, { baseUrl: ORIGIN })
const makePublicClientEffect = HttpApiClient.make(FhirPublicApi, { baseUrl: ORIGIN })

type ResourcesClient = Effect.Effect.Success<typeof makeResourcesClientEffect>
type PublicClient = Effect.Effect.Success<typeof makePublicClientEffect>

const makeResourcesClient = (httpClientLayer: FetchLayer): Promise<ResourcesClient> =>
  Effect.runPromise(makeResourcesClientEffect.pipe(Effect.provide(httpClientLayer)))

const makePublicClient = (httpClientLayer: FetchLayer): Promise<PublicClient> =>
  Effect.runPromise(makePublicClientEffect.pipe(Effect.provide(httpClientLayer)))

interface Wired {
  readonly resources: Awaited<ReturnType<typeof makeResourcesClient>>
  readonly public: Awaited<ReturnType<typeof makePublicClient>>
  readonly dispose: () => Promise<void>
  readonly store: Store<typeof schema, object>
}

// Each `wireServer()` boots a fresh in-memory livestore so cases stay
// independent. The returned typed clients route HTTP requests through the
// real `HttpApiBuilder.toWebHandler`, exercising the same Layer composition
// the production server uses (decoders, error mapping, prefix routing) — only
// the network hop is in-memory.
const wireServer = async (): Promise<Wired> => {
  const store = await createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema,
    storeId: `it-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  })
  const originLayer = Origin.layerFromLiteral(ORIGIN)
  const resourcesLive = FhirResourcesApiLive.pipe(
    Layer.provide(EmrStore.layerFrom(store)),
    Layer.provide(originLayer)
  )
  const publicLive = HttpApiBuilder.api(FhirPublicApi).pipe(
    Layer.provide(FhirPublicApiHandlersLive),
    Layer.provide(originLayer)
  )
  const merged = Layer.mergeAll(resourcesLive, publicLive, HttpServer.layerContext)
  const { handler, dispose } = HttpApiBuilder.toWebHandler(merged)
  const httpClientLayer = fetchLayerFor(handler)

  const resources = await makeResourcesClient(httpClientLayer)
  const publicClient = await makePublicClient(httpClientLayer)

  return {
    resources,
    public: publicClient,
    store,
    dispose: async (): Promise<void> => {
      await dispose()
      await store.shutdownPromise().catch((): undefined => undefined)
    },
  }
}

/**
 * Scoped resource for use inside `Effect.gen`. Acquires a fresh wired server
 * and tears it down (via `dispose`) when the surrounding scope closes. Pair
 * with `Effect.scoped(...)` at the test entry point.
 */
const wireServerScoped = Effect.acquireRelease(
  Effect.promise((): Promise<Wired> => wireServer()),
  (wired): Effect.Effect<void> => Effect.promise((): Promise<void> => wired.dispose())
)

export { wireServer, wireServerScoped, ORIGIN }
