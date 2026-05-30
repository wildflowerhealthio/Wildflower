import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import type { RunAuthed } from '../router-context.ts'

/**
 * Pins the startup prefetch. The `beforeLoad` auth gate now guarantees a
 * token before this runs, so there's no readiness skip anymore —
 * `prefetchKeyRoutes` always warms the key caches and returns a promise
 * that settles (success or error) so the caller can emit the embedded
 * `UIReady` handshake once prefetches finish.
 */

const TUNNEL_QUERY_KEY = ['tunnel', 'state'] as const

vi.mock('tunnel-react', () => ({
  tunnelStateQueryOptions: (_runAuthed: RunAuthed) => ({
    queryKey: TUNNEL_QUERY_KEY,
    queryFn: () => Promise.resolve('state'),
  }),
}))

const { prefetchKeyRoutes } = await import('./prefetch-key-routes.ts')

// The mocked `tunnelStateQueryOptions` ignores its argument, so this is
// never actually invoked; reject so any accidental call surfaces.
const stubRunAuthed: RunAuthed = () => Promise.reject(new Error('runAuthed not used in this test'))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('prefetchKeyRoutes', () => {
  test('warms the tunnel-state cache', () => {
    const queryClient = new QueryClient()
    const spy = vi.spyOn(queryClient, 'prefetchQuery')

    void prefetchKeyRoutes(queryClient, stubRunAuthed)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ queryKey: TUNNEL_QUERY_KEY })
  })

  test('returns a promise that settles once the warm completes', async () => {
    const queryClient = new QueryClient()

    await expect(prefetchKeyRoutes(queryClient, stubRunAuthed)).resolves.toBeUndefined()
  })
})
