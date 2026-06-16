import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, type AnyRoute } from '@tanstack/react-router'
import { Effect, Layer, pipe, SubscriptionRef } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'
import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import { describe, expect, test } from 'vite-plus/test'

import { TUNNEL_STATE_QUERY_KEY, type RunAuthed } from './queries.ts'
import type { RouterContext } from './router-context.ts'
import { sliceRuntimeLayer } from './router-context.ts'
import { routeTree } from './routeTree.gen.ts'

// Structural-only checks; no loader runs, so the runner is unused.
const stubRunAuthed: RunAuthed = () =>
  Promise.reject(new Error('runAuthed not used in route tests'))
const stubAwaitAuthReady = (): Promise<void> => Promise.resolve()
const router = createRouter({
  routeTree,
  context: {
    queryClient: new QueryClient(),
    runAuthed: stubRunAuthed,
    runtimeLayer: Layer.die('runtimeLayer not used in route tests'),
    awaitAuthReady: stubAwaitAuthReady,
  },
})

const routes = (): readonly AnyRoute[] =>
  Object.values(router.routesById).filter((route) => route.id !== '__root__')

describe('tunnel routes', () => {
  test('the generated tree exposes exactly the tunnel settings route', () => {
    const ids = routes().map((route) => route.id)
    expect(ids).toEqual(['/settings/tunnel/'])
  })

  test('the settings route resolves at /settings/tunnel/', () => {
    // The screen is an index route, so the resolved fullPath keeps the
    // trailing slash.
    expect(routes()[0]?.fullPath).toBe('/settings/tunnel/')
  })
})

// A stub `HttpClient` returning either a canned 200 `TunnelState` or a
// 500, so the loader's `ensureQueryData` resolves or rejects for real.
const TUNNEL_STATE_BODY = {
  revision: 0,
  publicHost: null,
  requestedRunning: false,
  running: false,
  error: null,
  attempt: 0,
  servedOrigin: 'http://127.0.0.1:8080',
}

const stubHttpClientLayer = (options?: {
  readonly failing?: boolean
}): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          options?.failing === true
            ? new Response(null, { status: 500 })
            : new Response(JSON.stringify(TUNNEL_STATE_BODY), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
        )
      )
    )
  )

// Mirrors the app's `buildRunAuthed`; kept local so the slice stays
// app-independent.
const makeRunAuthed = (httpLayer: Layer.Layer<HttpClient.HttpClient>): RunAuthed => {
  const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('token'))
  return <A, E>(
    effect: Effect.Effect<A, E, BearerToken | HttpClient.HttpClient | TunnelAdminHttpApiClient>
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          pipe(
            sliceRuntimeLayer,
            Layer.provideMerge(httpLayer),
            Layer.provideMerge(Layer.succeed(BearerToken, tokenRef))
          )
        ),
        Effect.scoped
      )
    )
}

// `runAuthed` tripwire: fails loudly if the loader calls it. Used to
// prove the readiness gate short-circuits before any HTTP attempt.
// Drives the loader through the router's real preload path (the same
// seam `defaultPreload: 'intent'` uses in the app), so loader errors are
// surfaced into match state exactly as the `errorComponent` would see
// them — no hand-built `LoaderFnContext`, no casts.
const preloadTunnel = async (
  context: RouterContext
): Promise<{ readonly status: string; readonly error: unknown }> => {
  const loaderRouter = createRouter({
    routeTree,
    context,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const matches = await loaderRouter.preloadRoute({ to: '/settings/tunnel' })
  const preloaded = matches?.find((m) => m.routeId === '/settings/tunnel/')
  if (preloaded === undefined) throw new Error('expected a match for /settings/tunnel/')
  // The array `preloadRoute` returns is a point-in-time snapshot; re-read
  // the settled match from the router store by id.
  const settled = loaderRouter.getMatch(preloaded.id)
  if (settled === undefined) throw new Error('expected the preloaded match to be retained')
  return { status: settled.status, error: settled.error }
}

describe('tunnel route loader', () => {
  test('warms the cache when the read succeeds', async () => {
    // Arrange — the `beforeLoad` gate guarantees a token, so the loader
    // always prefetches now (no readiness skip).
    const queryClient = new QueryClient()
    const context: RouterContext = {
      queryClient,
      runAuthed: makeRunAuthed(stubHttpClientLayer()),
      runtimeLayer: Layer.die('runtimeLayer not used by the loader'),
      awaitAuthReady: stubAwaitAuthReady,
    }

    // Act
    const result = await preloadTunnel(context)

    // Assert — loader warmed the cache for first paint.
    expect(result.status).toBe('success')
    expect(queryClient.getQueryData(TUNNEL_STATE_QUERY_KEY)).toMatchObject({
      servedOrigin: 'http://127.0.0.1:8080',
      running: false,
    })
  })

  test('propagates a genuine read failure to the error component instead of swallowing it', async () => {
    // Arrange — the read 500s. The pre-fix loader's bare `catch {}` hid
    // this; the match must now land in `error`.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const context: RouterContext = {
      queryClient,
      runAuthed: makeRunAuthed(stubHttpClientLayer({ failing: true })),
      runtimeLayer: Layer.die('runtimeLayer not used by the loader'),
      awaitAuthReady: stubAwaitAuthReady,
    }

    // Act
    const result = await preloadTunnel(context)

    // Assert — the failure reached the route (errorComponent renders it),
    // and no stale data was cached.
    expect(result.status).toBe('error')
    expect(result.error).toBeInstanceOf(Error)
    expect(queryClient.getQueryData(TUNNEL_STATE_QUERY_KEY)).toBeUndefined()
  })
})
