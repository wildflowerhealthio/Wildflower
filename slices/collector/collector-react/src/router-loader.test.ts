import { QueryClient, type UseSuspenseQueryOptions } from '@tanstack/react-query'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { ensureAuthedQuery } from './router-loader.ts'

/**
 * Pins the loader's token-ready guard (reconciled with the merged
 * gatekeeper helper): the `_auth` gate is a React component gate, so
 * loaders fire before auth. The readiness check reads through
 * `context.isTokenReady` — the single reader hoisted onto
 * `BaseRouterContext` — so this test injects it via context rather than
 * touching `authTokenRef`. On a not-ready token the loader MUST skip the
 * prefetch (no first-paint 401); on a ready token it MUST call
 * `ensureQueryData` and let genuine failures propagate (never a blanket
 * `catch`).
 */

const QUERY_KEY = ['collector', 'test'] as const

const stubOptions = (
  queryFn: () => string | Promise<string> = () => 'data'
): UseSuspenseQueryOptions<string, Error, string, typeof QUERY_KEY> => ({
  queryKey: QUERY_KEY,
  queryFn,
})

const tokenReady =
  (ready: boolean): (() => boolean) =>
  () =>
    ready

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ensureAuthedQuery', () => {
  test('skips the prefetch and resolves undefined when the token is not ready', async () => {
    const queryClient = new QueryClient()
    const spy = vi.spyOn(queryClient, 'ensureQueryData')

    const result = await ensureAuthedQuery(
      { queryClient, isTokenReady: tokenReady(false) },
      stubOptions()
    )

    expect(result).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  test('prefetches via ensureQueryData when the token is ready', async () => {
    const queryClient = new QueryClient()
    const spy = vi.spyOn(queryClient, 'ensureQueryData')
    const options = stubOptions()

    const result = await ensureAuthedQuery({ queryClient, isTokenReady: tokenReady(true) }, options)

    expect(spy).toHaveBeenCalledWith(options)
    expect(result).toBe('data')
  })

  test('reads readiness through context.isTokenReady (single source of truth)', async () => {
    const queryClient = new QueryClient()
    const spy = vi.spyOn(queryClient, 'ensureQueryData')
    const isTokenReady = vi.fn(() => false)

    await ensureAuthedQuery({ queryClient, isTokenReady }, stubOptions())

    expect(isTokenReady).toHaveBeenCalledTimes(1)
    expect(spy).not.toHaveBeenCalled()
  })

  test('lets a genuine read failure propagate (no blanket catch)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    await expect(
      ensureAuthedQuery(
        { queryClient, isTokenReady: tokenReady(true) },
        stubOptions(() => Promise.reject(new Error('boom')))
      )
    ).rejects.toThrow('boom')
  })
})
