import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { Effect, Layer, pipe, SubscriptionRef } from 'effect'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { BearerToken } from 'kitchen-sink/auth-token'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { sliceRuntimeLayer } from '../router-context.ts'
import {
  deviceConsentQueryOptions,
  GRANTS_QUERY_KEY,
  grantsQueryOptions,
  oauthConsentQueryOptions,
  REQUESTS_QUERY_KEY,
  requestsQueryOptions,
  type RunAuthed,
} from './index.ts'

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
    scopes: ['system/*.cruds', 'wildflower/*.cruds'],
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

// Wire shape mirrors `Devices.DeviceConsentSchema`.
const DEVICE_CONSENT_BODY = {
  userCode: 'WDJB-MJHT',
  clientId: 'client-a',
  clientName: 'Test Device',
  requestedScopes: ['system/*.cruds', 'wildflower/*.cruds'],
}

// Wire shape mirrors `OAuthConsent.OAuthConsentSchema`.
const OAUTH_CONSENT_BODY = {
  id: 'consent-1',
  clientId: 'client-a',
  scopes: ['patient/*.read'],
  redirectUri: 'https://example.com/cb',
  preApprovedScopes: [],
  patient: null,
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

  test('queryFn reads the grants list through the authed runner', async () => {
    const options = grantsQueryOptions(makeRunAuthed(stubHttpClientLayer({ body: GRANT_BODY })))
    const queryClient = freshQueryClient()

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
    const queryClient = freshQueryClient()

    const requests = await queryClient.ensureQueryData(options)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.status).toBe('pending')
  })
})

describe('deviceConsentQueryOptions', () => {
  test('keys the query under the user code', () => {
    const options = deviceConsentQueryOptions(makeRunAuthed(stubHttpClientLayer()), 'WDJB-MJHT')
    expect(options.queryKey).toEqual(['gatekeeper', 'device-consent', 'WDJB-MJHT'])
  })

  test('queryFn reads the device consent through the authed runner', async () => {
    const options = deviceConsentQueryOptions(
      makeRunAuthed(stubHttpClientLayer({ body: DEVICE_CONSENT_BODY })),
      'WDJB-MJHT'
    )
    const queryClient = freshQueryClient()

    const consent = await queryClient.ensureQueryData(options)

    expect(consent.userCode).toBe('WDJB-MJHT')
    expect(consent.clientName).toBe('Test Device')
    expect([...consent.requestedScopes]).toEqual(['system/*.cruds', 'wildflower/*.cruds'])
  })

  test('a failed read rejects ensureQueryData', async () => {
    const options = deviceConsentQueryOptions(
      makeRunAuthed(stubHttpClientLayer({ failing: true })),
      'WDJB-MJHT'
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    disposers.push(() => Promise.resolve(queryClient.clear()))

    await expect(queryClient.ensureQueryData(options)).rejects.toThrow()
  })
})

describe('oauthConsentQueryOptions', () => {
  test('keys the query under the consent id', () => {
    const options = oauthConsentQueryOptions(makeRunAuthed(stubHttpClientLayer()), 'consent-1')
    expect(options.queryKey).toEqual(['gatekeeper', 'oauth-consent', 'consent-1'])
  })

  test('queryFn reads the oauth consent through the authed runner', async () => {
    const options = oauthConsentQueryOptions(
      makeRunAuthed(stubHttpClientLayer({ body: OAUTH_CONSENT_BODY })),
      'consent-1'
    )
    const queryClient = freshQueryClient()

    const consent = await queryClient.ensureQueryData(options)

    expect(consent.id).toBe('consent-1')
    expect([...consent.scopes]).toEqual(['patient/*.read'])
  })

  test('a failed read rejects ensureQueryData', async () => {
    const options = oauthConsentQueryOptions(
      makeRunAuthed(stubHttpClientLayer({ failing: true })),
      'consent-1'
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    disposers.push(() => Promise.resolve(queryClient.clear()))

    await expect(queryClient.ensureQueryData(options)).rejects.toThrow()
  })
})
