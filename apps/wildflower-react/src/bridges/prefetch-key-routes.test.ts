import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import type { RunAuthed } from '../router-context.ts'

/**
 * Pins the startup prefetch's readiness gate. The reconciliation that
 * landed alongside the gatekeeper migration moved the "is the bearer
 * ready" check onto a single `isTokenReady` reader (hoisted to
 * `BaseRouterContext`, shared with gatekeeper's `ensureAuthedQuery`).
 * `prefetchKeyRoutes` now consults that injected reader instead of
 * reading `authTokenRef` directly — so a regression that warms the cache
 * on an embedded first paint (token not yet delivered → 401) is caught
 * here.
 */

const TUNNEL_QUERY_KEY = ['tunnel', 'state'] as const

vi.mock('tunnel-react', () => ({
  tunnelStateQueryOptions: (_runAuthed: RunAuthed) => ({
    queryKey: TUNNEL_QUERY_KEY,
    queryFn: () => Promise.resolve('state'),
  }),
}))

const { prefetchKeyRoutes } = await import('./prefetch-key-routes.ts')

// Never actually invoked: the prefetch is gated on `isTokenReady`, and the
// mocked `tunnelStateQueryOptions` ignores its argument. Reject so any
// accidental call surfaces instead of silently resolving.
const stubRunAuthed: RunAuthed = () => Promise.reject(new Error('runAuthed not used in this test'))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('prefetchKeyRoutes readiness gate', () => {
  test('skips the prefetch when the token is not ready', () => {
    const queryClient = new QueryClient()
    const spy = vi.spyOn(queryClient, 'prefetchQuery')

    prefetchKeyRoutes(queryClient, stubRunAuthed, () => false)

    expect(spy).not.toHaveBeenCalled()
  })

  test('warms the tunnel-state cache when the token is ready', () => {
    const queryClient = new QueryClient()
    const spy = vi.spyOn(queryClient, 'prefetchQuery')

    prefetchKeyRoutes(queryClient, stubRunAuthed, () => true)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ queryKey: TUNNEL_QUERY_KEY })
  })

  test('reads readiness through the injected isTokenReady (single source of truth)', () => {
    const queryClient = new QueryClient()
    vi.spyOn(queryClient, 'prefetchQuery')
    const isTokenReady = vi.fn(() => false)

    prefetchKeyRoutes(queryClient, stubRunAuthed, isTokenReady)

    expect(isTokenReady).toHaveBeenCalledTimes(1)
  })
})
