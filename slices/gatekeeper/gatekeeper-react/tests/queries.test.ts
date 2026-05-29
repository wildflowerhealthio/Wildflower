import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { Effect, Layer, pipe, SubscriptionRef } from 'effect'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { BearerToken } from 'kitchen-sink/auth-token'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import {
  GRANTS_QUERY_KEY,
  grantsQueryOptions,
  REQUESTS_QUERY_KEY,
  requestsQueryOptions,
  type RunAuthed,
} from '../src/queries.ts'
import { sliceRuntimeLayer } from '../src/router-context.ts'

/**
 * Drives the gatekeeper `queryOptions` over the real
 * runner → gatekeeper-layer → HttpClient path, with a stub HttpClient
 * that returns canned access-management bodies.
 */

// Wire shape mirrors `AccessManagement.GrantSchema` (DateTimeUtc encodes as ISO).
const GRANT_BODY = [
  {
    id: 'grant-1',
    clientId: 'client-a',
    scopes: ['owner'],
    redirectUri: 'https://example.com/cb',
    grantedAt: '2024-01-01T00:00:00.000Z',
    lastUsedAt: null,
    patient: null,
  },
]

// Wire shape mirrors `AccessManagement.HttpRequestSchema`.
const REQUEST_BODY = [
  {
    id: 'req-1',
    method: 'GET',
    url: '/Patient',
    origin: 'https://app.example',
    userAgent: 'test',
    requestedAt: '2024-01-01T00:00:00.000Z',
    status: 'pending',
    statusCode: null,
    respondedAt: null,
  },
]

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

// `failing: true` always 500s — exercises the loader's error-propagation path.
const stubHttpClientLayer = (options?: {
  readonly body?: unknown
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
            : jsonResponse(options?.body ?? [])
        )
      )
    )
  )

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()))
})

// Mirrors the app's `buildRunAuthed`; kept local so the slice has no app dep.
const makeRunAuthed = (httpLayer: Layer.Layer<HttpClient.HttpClient>): RunAuthed => {
  const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('token'))
  return <A, E>(
    effect: Effect.Effect<A, E, BearerToken | HttpClient.HttpClient | GatekeeperHttpApiClient>
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

describe('grantsQueryOptions', () => {
  test('exposes the canonical GRANTS_QUERY_KEY', () => {
    const options = grantsQueryOptions(makeRunAuthed(stubHttpClientLayer()))
    expect(options.queryKey).toEqual(GRANTS_QUERY_KEY)
  })

  test('queryFn reads the grants list through the authed runner', async () => {
    const options = grantsQueryOptions(makeRunAuthed(stubHttpClientLayer({ body: GRANT_BODY })))
    const queryClient = new QueryClient()
    disposers.push(() => Promise.resolve(queryClient.clear()))

    const grants = await queryClient.ensureQueryData(options)

    expect(grants).toHaveLength(1)
    expect(grants[0]?.clientId).toBe('client-a')
    expect(queryClient.getQueryData(GRANTS_QUERY_KEY)).toEqual(grants)
  })

  test('a failed read rejects ensureQueryData (propagates to the route errorComponent)', async () => {
    const options = grantsQueryOptions(makeRunAuthed(stubHttpClientLayer({ failing: true })))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    disposers.push(() => Promise.resolve(queryClient.clear()))

    await expect(queryClient.ensureQueryData(options)).rejects.toThrow()
    expect(queryClient.getQueryData(GRANTS_QUERY_KEY)).toBeUndefined()
  })
})

describe('requestsQueryOptions', () => {
  test('exposes the canonical REQUESTS_QUERY_KEY', () => {
    const options = requestsQueryOptions(makeRunAuthed(stubHttpClientLayer()))
    expect(options.queryKey).toEqual(REQUESTS_QUERY_KEY)
  })

  test('queryFn reads the requests list through the authed runner', async () => {
    const options = requestsQueryOptions(makeRunAuthed(stubHttpClientLayer({ body: REQUEST_BODY })))
    const queryClient = new QueryClient()
    disposers.push(() => Promise.resolve(queryClient.clear()))

    const requests = await queryClient.ensureQueryData(options)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.status).toBe('pending')
  })
})
