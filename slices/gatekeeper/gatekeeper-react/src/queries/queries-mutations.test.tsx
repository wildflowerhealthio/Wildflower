import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { type JSX, type ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { useDeviceConsentMutation } from './device-consent.ts'
import { useRevokeGrantMutation } from './grants.ts'
import { useOAuthConsentMutation } from './oauth-consent.ts'
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

const runAuthedStub = vi.fn((_effect: unknown) => Promise.resolve(undefined))

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
