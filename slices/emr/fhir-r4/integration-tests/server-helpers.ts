import type { HttpClient } from '@effect/platform'
import {
  FetchHttpClient,
  HttpApiBuilder,
  HttpApiClient,
  HttpMiddleware,
  HttpServer,
  HttpServerRequest,
} from '@effect/platform'
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, type Store } from '@livestore/livestore'
import { Effect, Layer } from 'effect'

import { EmrStore, schema } from 'emr-core/livestore'
import { Origin } from 'navigation-core'

import { FhirResourcesApi } from '../src/http-api-definition/index.ts'
import { FhirResourcesApiLive } from '../src/http-api-implementation/index.ts'

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

type ResourcesClient = Effect.Effect.Success<typeof makeResourcesClientEffect>

const makeResourcesClient = (httpClientLayer: FetchLayer): Promise<ResourcesClient> =>
  Effect.runPromise(makeResourcesClientEffect.pipe(Effect.provide(httpClientLayer)))

interface Wired {
  readonly resources: Awaited<ReturnType<typeof makeResourcesClient>>
  readonly handler: (req: Request) => Promise<Response>
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
  const merged = Layer.mergeAll(resourcesLive, HttpServer.layerContext)
  // `HttpApiBuilder.toWebHandler` wraps fetch `Request`s via
  // `HttpServerRequest.fromWeb`, which leaves `remoteAddress = None` since
  // a fetch `Request` has no TCP socket. Production paths
  // (`NodeHttpServer.layer`, `ExpoHttpServer.layer`) populate it from the
  // socket. To exercise the request-origin trust gate from tests, install
  // a middleware that reads a custom `x-test-remote-address` header (or
  // defaults to `127.0.0.1`) and overrides the wrapper's `None`.
  //
  // `HttpApp.toWebHandlerRuntime` attaches a `Symbol.for(...HttpApp/resolve)`
  // property to the original `HttpServerRequest`; `toHandled` invokes it to
  // fulfil the `Response` promise. `request.modify(...)` returns a fresh
  // `ServerRequestImpl` instance and does NOT copy that symbol, so without
  // the carry-over below every test request hangs into a bare 500
  // (`TypeError: request[resolveSymbol] is not a function`).
  const httpAppResolveSymbol = Symbol.for('@effect/platform/HttpApp/resolve')
  const { handler, dispose } = HttpApiBuilder.toWebHandler(merged, {
    middleware: HttpMiddleware.make((httpApp) =>
      Effect.updateService(httpApp, HttpServerRequest.HttpServerRequest, (request) => {
        const modified = request.modify({
          remoteAddress: request.headers['x-test-remote-address'] ?? '127.0.0.1',
        })
        /* oxlint-disable-next-line typescript/no-unsafe-type-assertion */
        const modifiedBag = modified as unknown as { [key: symbol]: unknown }
        /* oxlint-disable-next-line typescript/no-unsafe-type-assertion */
        const requestBag = request as unknown as { [key: symbol]: unknown }
        const resolve = requestBag[httpAppResolveSymbol]
        if (resolve === undefined) {
          // Fail loudly instead of silently regressing every test into a bare
          // 500: if @effect/platform stops attaching the resolve symbol (rename
          // or internal change), the carry-over below is a no-op and `toHandled`
          // can no longer fulfil the response. See the comment above.
          throw new Error(
            `wireServer: expected @effect/platform to attach ${String(
              httpAppResolveSymbol
            )} to the request, but it was missing — the resolve-symbol carry-over assumption has broken.`
          )
        }
        modifiedBag[httpAppResolveSymbol] = resolve
        return modified
      })
    ),
  })
  const httpClientLayer = fetchLayerFor(handler)

  const resources = await makeResourcesClient(httpClientLayer)

  return {
    resources,
    handler,
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
