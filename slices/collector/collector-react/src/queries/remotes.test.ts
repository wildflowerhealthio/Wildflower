import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import type { CollectorHttpApiClient } from 'collector-core/clients'
import { Effect, Layer, pipe, SubscriptionRef } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'
import { WebApiOrigin } from 'shared-structures-react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { sliceRuntimeLayer } from '../router-context.ts'
import {
  REMOTES_QUERY_KEY,
  remoteQueryOptions,
  remotesQueryOptions,
  type RunAuthed,
} from './index.ts'

/**
 * Drives the collector `queryOptions` over the real
 * runner → collector-layer → HttpClient path, with a stub HttpClient
 * that returns canned `CollectorApi` bodies.
 */

// Wire shape mirrors `Remotes.RemoteSchema` (DateTimeUtc encodes as ISO).
const REMOTE_BODY = {
  id: 'remote-1',
  name: 'Demo FHIR Server',
  tag: 'fhir-r4',
  config: {
    _tag: 'fhir-r4',
    rootUrl: 'https://r4.smarthealthit.org',
    patientId: 'patient-1',
  },
  addedAt: '2024-01-01T00:00:00.000Z',
}

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
    effect: Effect.Effect<
      A,
      E,
      BearerToken | HttpClient.HttpClient | CollectorHttpApiClient | WebApiOrigin
    >
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          pipe(
            sliceRuntimeLayer,
            Layer.provideMerge(httpLayer),
            Layer.provideMerge(Layer.succeed(BearerToken, tokenRef)),
            Layer.provideMerge(WebApiOrigin.layerFromLiteral('http://localhost'))
          )
        ),
        Effect.scoped
      )
    )
}

const freshQueryClient = (): QueryClient => {
  const queryClient = new QueryClient()
  disposers.push(() => Promise.resolve(queryClient.clear()))
  return queryClient
}

describe('remotesQueryOptions', () => {
  test('exposes the canonical REMOTES_QUERY_KEY', () => {
    const options = remotesQueryOptions(makeRunAuthed(stubHttpClientLayer()))
    expect(options.queryKey).toEqual(REMOTES_QUERY_KEY)
  })

  test('queryFn reads the remotes list through the authed runner', async () => {
    const options = remotesQueryOptions(makeRunAuthed(stubHttpClientLayer({ body: [REMOTE_BODY] })))
    const queryClient = freshQueryClient()

    const remotes = await queryClient.ensureQueryData(options)

    expect(remotes).toHaveLength(1)
    expect(remotes[0]?.name).toBe('Demo FHIR Server')
    expect(queryClient.getQueryData(REMOTES_QUERY_KEY)).toEqual(remotes)
  })

  test('a failed read rejects ensureQueryData (propagates to the route errorComponent)', async () => {
    const options = remotesQueryOptions(makeRunAuthed(stubHttpClientLayer({ failing: true })))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    disposers.push(() => Promise.resolve(queryClient.clear()))

    await expect(queryClient.ensureQueryData(options)).rejects.toThrow()
    expect(queryClient.getQueryData(REMOTES_QUERY_KEY)).toBeUndefined()
  })
})

describe('remoteQueryOptions', () => {
  test('keys the query under the remote id', () => {
    const options = remoteQueryOptions(makeRunAuthed(stubHttpClientLayer()), 'remote-1')
    expect(options.queryKey).toEqual(['collector', 'remote', 'remote-1'])
  })

  test('queryFn reads a single remote through the authed runner', async () => {
    const options = remoteQueryOptions(
      makeRunAuthed(stubHttpClientLayer({ body: REMOTE_BODY })),
      'remote-1'
    )
    const queryClient = freshQueryClient()

    const remote = await queryClient.ensureQueryData(options)

    expect(remote.id).toBe('remote-1')
    expect(remote.config._tag).toBe('fhir-r4')
  })

  test('a failed read rejects ensureQueryData', async () => {
    const options = remoteQueryOptions(
      makeRunAuthed(stubHttpClientLayer({ failing: true })),
      'remote-1'
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    disposers.push(() => Promise.resolve(queryClient.clear()))

    await expect(queryClient.ensureQueryData(options)).rejects.toThrow()
  })
})
