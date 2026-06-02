import { Effect, SubscriptionRef } from 'effect'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { consumeUrlTokenIntoLocalStorage, TOKEN_STORAGE_KEY } from './token-storage.ts'

/**
 * `token-storage.ts` runs `consumeUrlTokenIntoLocalStorage` at module
 * load; jsdom's default URL has no `?token=` so the module-level call is
 * a no-op. We re-drive the helper directly with controlled URLs to cover
 * the dev-mode bootstrap path documented in gatekeeper-core's README.
 */

// jsdom's `history.replaceState` only permits same-origin URLs, so the
// test fixtures stay on the jsdom default origin (captured at module
// load — vitest doesn't expose it as a constant).
const ORIGIN = new URL(window.location.href).origin

const setLocation = (path: string): void => {
  window.history.replaceState(null, '', `${ORIGIN}${path}`)
}

const FRESH_TOKEN = 'fresh-bootstrap-token'

describe('consumeUrlTokenIntoLocalStorage', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setLocation('/')
  })

  afterEach(() => {
    window.localStorage.clear()
    setLocation('/')
  })

  test('writes ?token= into localStorage and strips it from the URL', () => {
    setLocation(`/home?token=${FRESH_TOKEN}`)

    consumeUrlTokenIntoLocalStorage()

    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(FRESH_TOKEN)
    expect(window.location.href).toBe(`${ORIGIN}/home`)
  })

  test('overwrites a stale localStorage value with the URL token', () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'stale-token')
    setLocation(`/home?token=${FRESH_TOKEN}`)

    consumeUrlTokenIntoLocalStorage()

    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(FRESH_TOKEN)
  })

  test('preserves other query parameters when stripping ?token=', () => {
    setLocation(`/home?keep=yes&token=${FRESH_TOKEN}&also=ok`)

    consumeUrlTokenIntoLocalStorage()

    const url = new URL(window.location.href)
    expect(url.searchParams.get('token')).toBe(null)
    expect(url.searchParams.get('keep')).toBe('yes')
    expect(url.searchParams.get('also')).toBe('ok')
  })

  test('no-op when ?token= is absent', () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'existing-token')
    setLocation('/home?other=1')

    consumeUrlTokenIntoLocalStorage()

    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('existing-token')
    expect(window.location.href).toBe(`${ORIGIN}/home?other=1`)
  })

  test('no-op when ?token= is empty', () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'existing-token')
    setLocation('/home?token=')

    consumeUrlTokenIntoLocalStorage()

    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('existing-token')
    expect(window.location.href).toBe(`${ORIGIN}/home?token=`)
  })
})

/**
 * The functional tests above call `consumeUrlTokenIntoLocalStorage`
 * directly. The dev-mode bootstrap only works if the side-effect at
 * module-load also fires — and *before* `authTokenRef` is constructed
 * from `readInitialToken()`. We exercise that by clearing the module
 * cache, painting the URL with `?token=`, re-importing `token-storage`,
 * and asserting `authTokenRef` came out of the import already holding
 * the URL token (so `webAuthReadyEffect` resolves instead of redirecting).
 */
describe('token-storage module load', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setLocation('/')
    vi.resetModules()
  })

  afterEach(() => {
    window.localStorage.clear()
    setLocation('/')
    vi.resetModules()
  })

  test('authTokenRef is seeded from ?token= on module load', async () => {
    setLocation(`/home?token=${FRESH_TOKEN}`)

    const reloaded: typeof import('./token-storage.ts') = await import('./token-storage.ts')

    // URL was stripped at module load
    expect(window.location.href).toBe(`${ORIGIN}/home`)
    // localStorage holds the URL token
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(FRESH_TOKEN)
    // authTokenRef picked up the URL token as its initial value
    const initial = await Effect.runPromise(SubscriptionRef.get(reloaded.authTokenRef))
    expect(initial).toBe(FRESH_TOKEN)
  })

  test('?token= wins over a stale localStorage value at module load', async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'stale-token')
    setLocation(`/home?token=${FRESH_TOKEN}`)

    const reloaded: typeof import('./token-storage.ts') = await import('./token-storage.ts')

    const initial = await Effect.runPromise(SubscriptionRef.get(reloaded.authTokenRef))
    expect(initial).toBe(FRESH_TOKEN)
  })
})
