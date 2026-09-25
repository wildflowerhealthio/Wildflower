import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { DateTime, Effect, Layer, pipe, TestClock, TestContext } from 'effect'
import * as fc from 'fast-check'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { numRunsFor } from 'kitchen-sink/test'
import { type JSX, type ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { sliceRuntimeLayer } from '../router-context.ts'
import { useUpdateClientMutation } from './clients.ts'
import { useDeviceConsentMutation } from './device-consent.ts'
import { useRevokeGrantMutation } from './grants.ts'
import { foldExpiredConsent, useOAuthConsentMutation } from './oauth-consent.ts'
import { useDecideRequestMutation } from './requests.ts'

/**
 * Pins each gatekeeper mutation's `onSuccess` invalidation keys — the
 * whole point of the TanStack migration is that refetches ride
 * `invalidateQueries` rather than the old `refreshKey`, so a wrong key
 * (e.g. invalidating the wrong root, or a dead self-invalidate that a
 * navigated-away screen never re-reads) is a silent regression CI would
 * otherwise pass.
 *
 * The mutations read `runAuthed` from router context via
 * `useRouteContext({ from: '__root__' })`. Rather than mount a whole
 * router, mock `useRouteContext` to feed the stub runner through its
 * `select`, and provide a real `QueryClientProvider` so `useQueryClient`
 * and `useMutation` resolve. The transport is stubbed: `runAuthed`
 * resolves immediately so `onSuccess` fires and we can read the spied
 * `invalidateQueries` calls.
 */

const runAuthedStub = vi.fn(
  (_effect: Effect.Effect<unknown, unknown, HttpClient.HttpClient | GatekeeperHttpApiClient>) =>
    Promise.resolve<unknown>(undefined)
)

vi.mock('@tanstack/react-router', () => ({
  // Mirrors `useRouteContext({ from, select })`: the slice's
  // `useRunAuthed` passes a `select` that pulls `context.runAuthed`.
  useRouteContext: ({
    select,
  }: {
    select: (context: { runAuthed: unknown }) => unknown
  }): unknown => select({ runAuthed: runAuthedStub }),
}))

const renderWithClient = <THook,>(
  useHook: () => THook
): { result: { current: THook }; queryClient: QueryClient } => {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(useHook, { wrapper })
  return { result, queryClient }
}

afterEach(() => {
  runAuthedStub.mockClear()
})

describe('useRevokeGrantMutation invalidation', () => {
  test('invalidates the grants list root and the revoked grant detail', async () => {
    const { result, queryClient } = renderWithClient(() => useRevokeGrantMutation())
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await result.current.mutateAsync({ id: 'grant-1' })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['gatekeeper', 'grants'] })
    })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['gatekeeper', 'grant', 'grant-1'] })
  })
})

const clientSwitches = ['disable', 'enable'] as const

describe('useUpdateClientMutation invalidation', () => {
  test.each(clientSwitches)('%s invalidates the clients list root', async (action) => {
    const { result, queryClient } = renderWithClient(() => useUpdateClientMutation())
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await result.current.mutateAsync({ clientId: 'ohif-viewer', action })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['gatekeeper', 'clients'] })
    })
  })
})

describe('useUpdateClientMutation request', () => {
  test('disable PATCHes the client resource with the Clock time', async () => {
    // Arrange
    const now = DateTime.unsafeMake('2026-09-01T12:00:00.000Z')
    const requests = routeRunAuthedThroughRecordingHttpClient(now)
    const { result } = renderWithClient(() => useUpdateClientMutation())

    // Act
    const updated = await result.current.mutateAsync({ clientId: 'ohif-viewer', action: 'disable' })

    // Assert
    expect(requests.map(({ method, body }) => ({ method, body }))).toEqual([
      { method: 'PATCH', body: { disabledAt: '2026-09-01T12:00:00.000Z' } },
    ])
    expect(requests[0]?.url).toMatch(/\/access\/clients\/ohif-viewer$/)
    expect(updated.clientId).toBe(respondedClient.clientId)
  })

  test('enable PATCHes the client resource with a null disabledAt', async () => {
    // Arrange
    const requests = routeRunAuthedThroughRecordingHttpClient(DateTime.unsafeMake(0))
    const { result } = renderWithClient(() => useUpdateClientMutation())

    // Act
    await result.current.mutateAsync({ clientId: 'ohif-viewer', action: 'enable' })

    // Assert
    expect(requests.map(({ method, body }) => ({ method, body }))).toEqual([
      { method: 'PATCH', body: { disabledAt: null } },
    ])
  })

  test('should always send the Clock time when disabling', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.date({ noInvalidDate: true }).map((date) => DateTime.unsafeMake(date)),
        async (now) => {
          // Arrange
          const requests = routeRunAuthedThroughRecordingHttpClient(now)
          const { result } = renderWithClient(() => useUpdateClientMutation())

          // Act
          await result.current.mutateAsync({ clientId: 'ohif-viewer', action: 'disable' })

          // Assert
          expect(requests.map(({ body }) => body)).toEqual([
            { disabledAt: DateTime.formatIso(now) },
          ])
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('keeps a URL-shaped client id in a single path segment', async () => {
    // Arrange — trust on first use admits any `client_id`, including URLs.
    const clientId = 'https://app.example.com/client'
    const requests = routeRunAuthedThroughRecordingHttpClient(DateTime.unsafeMake(0))
    const { result } = renderWithClient(() => useUpdateClientMutation())

    // Act
    await result.current.mutateAsync({ clientId, action: 'enable' })

    // Assert
    expect(requests.map(({ url }) => url)).toEqual([
      expect.stringMatching(new RegExp(`/clients/${escapeRegExp(encodeURIComponent(clientId))}$`)),
    ])
  })

  test('should always round-trip any client id through its path segment', async () => {
    await fc.assert(
      fc.asyncProperty(
        // `webUrl` biases toward `/`, `?`, `#` and `%` — plain strings rarely hit them.
        fc.oneof(
          fc.string({ unit: 'binary' }),
          fc.webUrl({ withQueryParameters: true, withFragments: true })
        ),
        fc.constantFrom(...clientSwitches),
        async (clientId, action) => {
          // Arrange
          const requests = routeRunAuthedThroughRecordingHttpClient(DateTime.unsafeMake(0))
          const { result } = renderWithClient(() => useUpdateClientMutation())

          // Act
          await result.current.mutateAsync({ clientId, action })

          // Assert
          const segment = /\/clients\/([^/?#]*)$/.exec(requests[0]?.url ?? '')
          expect(segment).not.toBeNull()
          expect(decodeURIComponent(segment?.[1] ?? '')).toBe(clientId)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('useDecideRequestMutation invalidation', () => {
  test('approving invalidates the requests list root and the decided request detail', async () => {
    const { result, queryClient } = renderWithClient(() => useDecideRequestMutation())
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await result.current.mutateAsync({ id: 'req-1', decision: 'approved' })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['gatekeeper', 'requests'] })
    })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['gatekeeper', 'request', 'req-1'] })
  })

  test('rejecting invalidates the same list + detail keys', async () => {
    const { result, queryClient } = renderWithClient(() => useDecideRequestMutation())
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await result.current.mutateAsync({ id: 'req-2', decision: 'rejected' })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['gatekeeper', 'requests'] })
    })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['gatekeeper', 'request', 'req-2'] })
  })
})

describe('useDeviceConsentMutation invalidation', () => {
  test('invalidates the grants list root (the surface the user lands on), not its own detail', async () => {
    const { result, queryClient } = renderWithClient(() => useDeviceConsentMutation())
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await result.current.mutateAsync({ kind: 'approve', userCode: 'WDJB-MJHT', approvedScopes: [] })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['gatekeeper', 'grants'] })
    })
    // The screen unmounts on success, so a self-invalidate of the consent
    // detail would be dead code — assert it does NOT fire.
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ['gatekeeper', 'device-consent', 'WDJB-MJHT'],
    })
  })
})

describe('foldExpiredConsent', () => {
  test('folds an OAuthConsentNotFound failure into the error result with retry copy', async () => {
    // Arrange — the failure shape the server returns once the consent's
    // 5-minute TTL has passed (expired reads as not-found).
    const notFound = Effect.fail({ error: 'OAuthConsentNotFound', id: 'consent-9' })

    // Act
    const decision = await Effect.runPromise(foldExpiredConsent(notFound))

    // Assert — the 404 becomes the result's error arm, with try-again copy.
    expect(decision).toEqual({
      status: 'error',
      message:
        'This authorization request has expired or was already completed. Return to the app and try connecting again.',
    })
  })

  test('passes an unrelated failure through untouched', async () => {
    const transportFailure = Effect.fail(new Error('socket hang up'))

    await expect(Effect.runPromise(foldExpiredConsent(transportFailure))).rejects.toThrow(
      'socket hang up'
    )
  })
})

describe('useOAuthConsentMutation invalidation', () => {
  test('invalidates the grants list root, not its own detail', async () => {
    const { result, queryClient } = renderWithClient(() => useOAuthConsentMutation())
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await result.current.mutateAsync({ kind: 'deny', id: 'consent-1' })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['gatekeeper', 'grants'] })
    })
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ['gatekeeper', 'oauth-consent', 'consent-1'],
    })
  })
})

// Helpers

/** The client the recording stub answers `UpdateClient` with, as JSON. */
const respondedClient = {
  clientId: 'ohif-viewer',
  name: 'OHIF Viewer',
  kind: 'public',
  redirectUris: ['/'],
  allowedScopes: ['openid'],
  allowedGrantTypes: ['authorization_code'],
  registeredAt: '2026-01-15T09:30:00.000Z',
  disabledAt: null,
  firstParty: false,
}

/** One request as the recording stub saw it; `body` is the parsed JSON, if any. */
interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body: unknown
}

/**
 * Makes the next `runAuthed` call run its effect for real over a stub
 * `HttpClient` that answers `200` with {@link respondedClient} and records
 * each request — so a test can read the method, path and body `HttpApiClient`
 * actually built. The effect's `Clock` is a `TestClock` set to `now`.
 */
const routeRunAuthedThroughRecordingHttpClient = (
  now: DateTime.Utc
): readonly RecordedRequest[] => {
  const requests: RecordedRequest[] = []
  const recordingHttpClient = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push({
        method: request.method,
        url: request.url,
        body:
          request.body._tag === 'Uint8Array'
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined,
      })
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json(respondedClient, { status: 200 }))
      )
    })
  )
  runAuthedStub.mockImplementationOnce((effect) =>
    Effect.runPromise(
      TestClock.setTime(DateTime.toEpochMillis(now)).pipe(
        Effect.zipRight(effect),
        Effect.provide(pipe(sliceRuntimeLayer, Layer.provideMerge(recordingHttpClient))),
        Effect.provide(TestContext.TestContext),
        Effect.scoped
      )
    )
  )
  return requests
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
