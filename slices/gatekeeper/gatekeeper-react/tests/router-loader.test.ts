import { QueryClient, type UseSuspenseQueryOptions } from '@tanstack/react-query'
import { Effect, SubscriptionRef } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { authTokenRef } from '../src/client/token-storage.ts'
import { ensureAuthedQuery } from '../src/router-loader.ts'

/**
 * Pins the loader's token-ready guard (the merged-review learning): the
 * `_auth`/`settings` gates are React component gates, so loaders fire
 * before auth. On an empty token the loader MUST skip the prefetch (no
 * first-paint 401); on a present token it MUST call `ensureQueryData` and
 * let genuine failures propagate (never a blanket `catch`).
 */

const QUERY_KEY = ['gatekeeper', 'test'] as const

const stubOptions = (
  queryFn: () => string | Promise<string> = () => 'data'
): UseSuspenseQueryOptions<string, Error, string, typeof QUERY_KEY> => ({
  queryKey: QUERY_KEY,
  queryFn,
})

afterEach(() => {
  Effect.runSync(SubscriptionRef.set(authTokenRef, null))
  vi.restoreAllMocks()
})

describe('ensureAuthedQuery', () => {
  test('skips the prefetch and resolves undefined when no token is ready', async () => {
    Effect.runSync(SubscriptionRef.set(authTokenRef, null))
    const queryClient = new QueryClient()
    const spy = vi.spyOn(queryClient, 'ensureQueryData')

    const result = await ensureAuthedQuery({ queryClient }, stubOptions())

    expect(result).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  test('skips the prefetch when the token is an empty string', async () => {
    Effect.runSync(SubscriptionRef.set(authTokenRef, ''))
    const queryClient = new QueryClient()
    const spy = vi.spyOn(queryClient, 'ensureQueryData')

    await ensureAuthedQuery({ queryClient }, stubOptions())

    expect(spy).not.toHaveBeenCalled()
  })

  test('prefetches via ensureQueryData when a token is present', async () => {
    Effect.runSync(SubscriptionRef.set(authTokenRef, 'a-token'))
    const queryClient = new QueryClient()
    const spy = vi.spyOn(queryClient, 'ensureQueryData')
    const options = stubOptions()

    const result = await ensureAuthedQuery({ queryClient }, options)

    expect(spy).toHaveBeenCalledWith(options)
    expect(result).toBe('data')
  })

  test('lets a genuine read failure propagate (no blanket catch)', async () => {
    Effect.runSync(SubscriptionRef.set(authTokenRef, 'a-token'))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    await expect(
      ensureAuthedQuery(
        { queryClient },
        stubOptions(() => Promise.reject(new Error('boom')))
      )
    ).rejects.toThrow('boom')
  })
})
