import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { Effect, Layer, pipe } from 'effect'
import * as fc from 'fast-check'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { numRunsFor } from 'kitchen-sink/test'
import { type JSX, type ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { sliceRuntimeLayer } from '../router-context.ts'
import { type ClientSwitch, useSetClientDisabledMutation } from './clients.ts'
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

describe('useSetClientDisabledMutation invalidation', () => {
  test.each(['disable', 'enable'] as const)(
    '%s invalidates the clients list root',
    async (action) => {
      const { result, queryClient } = renderWithClient(() => useSetClientDisabledMutation())
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

      await result.current.mutateAsync({ clientId: 'ohif-viewer', action })

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['gatekeeper', 'clients'] })
      })
    }
  )
})

describe('useSetClientDisabledMutation request path', () => {
  test.each(['disable', 'enable'] as const)(
    '%s keeps a URL-shaped client id in a single path segment',
    async (action) => {
      // Arrange — trust on first use admits any `client_id`, including URLs.
      const clientId = 'https://app.example.com/client'
      const requestedUrls = routeRunAuthedThroughRecordingHttpClient()
      const { result } = renderWithClient(() => useSetClientDisabledMutation())

      // Act
      await result.current.mutateAsync({ clientId, action })

      // Assert
      expect(requestedUrls).toEqual([
        expect.stringMatching(
          new RegExp(`/clients/${escapeRegExp(encodeURIComponent(clientId))}/${action}$`)
        ),
      ])
    }
  )

  test('should always round-trip any client id through its path segment', async () => {
    await fc.assert(
      fc.asyncProperty(
        // `webUrl` biases toward `/`, `?`, `#` and `%` — plain strings rarely hit them.
        fc.oneof(
          fc.string({ unit: 'binary' }),
          fc.webUrl({ withQueryParameters: true, withFragments: true })
        ),
        fc.constantFrom<ClientSwitch>('disable', 'enable'),
        async (clientId, action) => {
          // Arrange
          const requestedUrls = routeRunAuthedThroughRecordingHttpClient()
          const { result } = renderWithClient(() => useSetClientDisabledMutation())

          // Act
          await result.current.mutateAsync({ clientId, action })

          // Assert
          const segment = /\/clients\/([^/?#]*)\/(?:disable|enable)$/.exec(requestedUrls[0] ?? '')
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

/**
 * Makes the next `runAuthed` call run its effect for real over a stub
 * `HttpClient` that answers `204` and records each request URL — so a test
 * can read the path `HttpApiClient` actually built.
 */
const routeRunAuthedThroughRecordingHttpClient = (): readonly string[] => {
  const requestedUrls: string[] = []
  const recordingHttpClient = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requestedUrls.push(request.url)
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))
      )
    })
  )
  runAuthedStub.mockImplementationOnce((effect) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(pipe(sliceRuntimeLayer, Layer.provideMerge(recordingHttpClient))),
        Effect.scoped
      )
    )
  )
  return requestedUrls
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
