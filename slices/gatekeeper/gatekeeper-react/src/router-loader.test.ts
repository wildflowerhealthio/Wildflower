import { QueryClient, type UseSuspenseQueryOptions } from '@tanstack/react-query'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { ensureAuthedQuery } from './router-loader.ts'

/**
 * Pins the authed loader helper. The `_auth`/`settings` layouts now gate
 * on a `beforeLoad` that `await`s the bearer token, so by the time this
 * loader runs the token is guaranteed present — there's no readiness
 * skip anymore. `ensureAuthedQuery` always calls `ensureQueryData` and
 * lets genuine failures propagate (never a blanket `catch`).
 */

const QUERY_KEY = ['gatekeeper', 'test'] as const

const stubOptions = (
  queryFn: () => string | Promise<string> = () => 'data'
): UseSuspenseQueryOptions<string, Error, string, typeof QUERY_KEY> => ({
  queryKey: QUERY_KEY,
  queryFn,
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ensureAuthedQuery', () => {
  test('prefetches via ensureQueryData and returns the data', async () => {
    const queryClient = new QueryClient()
    const spy = vi.spyOn(queryClient, 'ensureQueryData')
    const options = stubOptions()

    const result = await ensureAuthedQuery({ queryClient }, options)

    expect(spy).toHaveBeenCalledWith(options)
    expect(result).toBe('data')
  })

  test('lets a genuine read failure propagate (no blanket catch)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    await expect(
      ensureAuthedQuery(
        { queryClient },
        stubOptions(() => Promise.reject(new Error('boom')))
      )
    ).rejects.toThrow('boom')
  })
})
