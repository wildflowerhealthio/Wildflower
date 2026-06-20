import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, type AnyRoute } from '@tanstack/react-router'
import type { Databases } from 'databases-core/http-api-definition'
import { Effect, Layer, pipe, SubscriptionRef } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'
import { describe, expect, test } from 'vite-plus/test'

import { DATABASES_QUERY_KEY, type RunAuthed } from './queries.ts'
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

describe('databases routes', () => {
  test('the generated tree exposes the data-management screen', () => {
    const ids = routes().map((route) => route.id)
    expect(ids).toEqual(['/settings/databases/'])
  })

  test('the screen resolves at /settings/databases/', () => {
    const byId = new Map(routes().map((route) => [route.id, route]))
    expect(byId.get('/settings/databases/')?.fullPath).toBe('/settings/databases/')
  })
})

// A canned `GET /databases` body the stub client returns.
const DATABASES_BODY: readonly Schema_DatabaseMetadata[] = [
  {
    id: 'health-data.sqlite',
    label: 'Health data',
    description: 'Your FHIR clinical records.',
    exists: true,
    sizeBytes: 4096,
    tableCount: 7,
    modifiedAt: '2026-06-20T00:00:00.000Z',
    pendingDeletion: false,
  },
  {
    id: 'wildflower.sqlite',
    label: 'Wildflower app data',
    description: 'App state.',
    exists: false,
    sizeBytes: 0,
    pendingDeletion: false,
  },
]
// The stub returns a wire (encoded) body the schema decodes — `modifiedAt` is a
// string here, then decoded to a `DateTime.Utc`.
type Schema_DatabaseMetadata = typeof Databases.DatabaseMetadataSchema.Encoded

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
            : new Response(JSON.stringify(DATABASES_BODY), {
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
  return ((effect) =>
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
    )) as RunAuthed
}

const preloadDatabases = async (
  context: RouterContext
): Promise<{ readonly status: string; readonly error: unknown }> => {
  const loaderRouter = createRouter({
    routeTree,
    context,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const matches = await loaderRouter.preloadRoute({ to: '/settings/databases' })
  const preloaded = matches?.find((match) => match.routeId === '/settings/databases/')
  if (preloaded === undefined) throw new Error('expected a match for /settings/databases/')
  const settled = loaderRouter.getMatch(preloaded.id)
  if (settled === undefined) throw new Error('expected the preloaded match to be retained')
  return { status: settled.status, error: settled.error }
}

describe('databases route loader', () => {
  test('warms the cache when the read succeeds', async () => {
    const queryClient = new QueryClient()
    const context: RouterContext = {
      queryClient,
      runAuthed: makeRunAuthed(stubHttpClientLayer()),
      runtimeLayer: Layer.die('runtimeLayer not used by the loader'),
      awaitAuthReady: stubAwaitAuthReady,
    }

    const result = await preloadDatabases(context)

    expect(result.status).toBe('success')
    const cached = queryClient.getQueryData(DATABASES_QUERY_KEY)
    expect(Array.isArray(cached)).toBe(true)
    expect(cached).toHaveLength(2)
  })

  test('propagates a genuine read failure to the error component instead of swallowing it', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const context: RouterContext = {
      queryClient,
      runAuthed: makeRunAuthed(stubHttpClientLayer({ failing: true })),
      runtimeLayer: Layer.die('runtimeLayer not used by the loader'),
      awaitAuthReady: stubAwaitAuthReady,
    }

    const result = await preloadDatabases(context)

    expect(result.status).toBe('error')
    expect(result.error).toBeInstanceOf(Error)
    expect(queryClient.getQueryData(DATABASES_QUERY_KEY)).toBeUndefined()
  })
})
