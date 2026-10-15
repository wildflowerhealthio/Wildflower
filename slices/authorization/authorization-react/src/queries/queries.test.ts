import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import type { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import { Effect, Layer, pipe } from 'effect'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { sliceRuntimeLayer } from '../router-context.ts'
import { GRANTS_QUERY_KEY, grantsQueryOptions, type RunAuthed } from './index.ts'

/**
 * Drives the authorization server `queryOptions` over the real
 * runner → authorization-server-layer → HttpClient path, with a stub HttpClient
 * that returns canned access-management bodies.
 */

// Wire shape mirrors `AccessManagement.GrantSchema` — the `authorization_code`
// variant of the grantType-tagged union (DateTimeUtc encodes as ISO).
const GRANT_BODY = [
  {
    id: 'grant-1',
    clientId: 'client-a',
    scopes: ['system/*.cruds', 'wildflower/*.cruds'],
    grantType: 'authorization_code',
    redirectUri: 'https://example.com/cb',
    grantedAt: '2024-01-01T00:00:00.000Z',
    lastUsedAt: null,
    patient: null,
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
  return <A, E>(
    effect: Effect.Effect<A, E, HttpClient.HttpClient | AuthorizationServerHttpApiClient>
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(pipe(sliceRuntimeLayer, Layer.provideMerge(httpLayer))),
        Effect.scoped
      )
    )
}

const freshQueryClient = (): QueryClient => {
  const queryClient = new QueryClient()
  disposers.push(() => Promise.resolve(queryClient.clear()))
  return queryClient
}

describe('grantsQueryOptions', () => {
  test('exposes the canonical GRANTS_QUERY_KEY', () => {
    const options = grantsQueryOptions(makeRunAuthed(stubHttpClientLayer()))
    expect(options.queryKey).toEqual(GRANTS_QUERY_KEY)
  })

  test('re-fetches on mount so a newly-authorized grant is never masked by the stale cache', () => {
    // Authorizing an app / pairing a device happens outside this React tree, so
    // nothing invalidates the list; without an always-refetch the app's 5-minute
    // staleTime would keep the just-added grant hidden until the window elapsed.
    const options = grantsQueryOptions(makeRunAuthed(stubHttpClientLayer()))
    expect(options.refetchOnMount).toBe('always')
  })

  test('queryFn reads the grants list through the authed runner', async () => {
    const options = grantsQueryOptions(makeRunAuthed(stubHttpClientLayer({ body: GRANT_BODY })))
    const queryClient = freshQueryClient()

    const grants = await queryClient.query({ ...options, staleTime: 'static' })

    expect(grants).toHaveLength(1)
    expect(grants[0]?.clientId).toBe('client-a')
    expect(queryClient.getQueryData(GRANTS_QUERY_KEY)).toEqual(grants)
  })

  test('a failed read rejects ensureQueryData (propagates to the route errorComponent)', async () => {
    const options = grantsQueryOptions(makeRunAuthed(stubHttpClientLayer({ failing: true })))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    disposers.push(() => Promise.resolve(queryClient.clear()))

    await expect(queryClient.query({ ...options, staleTime: 'static' })).rejects.toThrow()
    expect(queryClient.getQueryData(GRANTS_QUERY_KEY)).toBeUndefined()
  })
})
