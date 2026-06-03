import { Effect, SubscriptionRef } from 'effect'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from 'vite-plus/test'
import type * as TokenStorageType from './token-storage.ts'
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

// A valid JWT shape (three non-empty base64url segments separated by
// dots) — `token-storage` now validates the `?token=` value against this
// shape before persisting, so the bootstrap fixtures must look like real
// tokens.
const FRESH_TOKEN = 'header-segment.payload-segment.signature-segment'

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

  test('rejects a malformed (non-JWT-shaped) ?token= without clobbering storage', () => {
    // `garbage` is a single segment — not three dot-separated base64url
    // segments — so the shape validation rejects it and the existing
    // stored token survives. The param is still stripped from the URL so
    // the bad value doesn't linger.
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'existing-token')
    setLocation('/home?token=garbage')

    consumeUrlTokenIntoLocalStorage()

    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('existing-token')
    expect(window.location.href).toBe(`${ORIGIN}/home`)
  })

  // (c.1) Encoding-sensitive but invalid-shaped token: base64url excludes
  // `+`, `/`, `=`, and space, so `a b+c` survives the URL encode->decode
  // round-trip but fails the JWT shape check. It must be rejected and must
  // not clobber the existing stored token.
  test('rejects an encoding-sensitive but malformed ?token= without clobbering storage', () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'existing-token')
    // Build the URL via `URLSearchParams` so `a b+c` is percent-encoded in
    // the address bar exactly as a real `?token=` would be.
    const params = new URLSearchParams({ token: 'a b+c' })
    setLocation(`/home?${params.toString()}`)

    consumeUrlTokenIntoLocalStorage()

    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('existing-token')
    expect(window.location.href).toBe(`${ORIGIN}/home`)
  })

  // (c.2) Valid 3-segment base64url token: stresses the URL/searchParams
  // round-trip with a value full of base64url-legal `-` and `_` chars and
  // confirms it survives decoding and is persisted.
  test('round-trips and persists a valid base64url-shaped ?token=', () => {
    const validToken = 'aB-_0.cD-_1.eF-_2'
    const params = new URLSearchParams({ token: validToken })
    setLocation(`/home?${params.toString()}`)

    consumeUrlTokenIntoLocalStorage()

    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(validToken)
    expect(window.location.href).toBe(`${ORIGIN}/home`)
  })

  // (a) `history.replaceState`-unavailable guard: with `replaceState`
  // missing, the function must be a no-op — no throw, no storage write,
  // no URL change.
  test('no-op when history.replaceState is unavailable', () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'existing-token')
    setLocation(`/home?token=${FRESH_TOKEN}`)
    // `replaceState` is inherited from `History.prototype`, so shadow it
    // with an own `undefined` data property to drive the guard
    // (`typeof window.history.replaceState !== 'function'`). Restore by
    // deleting the own shadow, re-exposing the prototype method. Defining
    // a descriptor avoids assigning `undefined` to the typed member.
    Object.defineProperty(window.history, 'replaceState', {
      value: undefined,
      configurable: true,
      writable: true,
    })

    try {
      expect(() => {
        consumeUrlTokenIntoLocalStorage()
      }).not.toThrow()

      // Storage untouched and URL left intact: the function bailed early.
      expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('existing-token')
      expect(window.location.href).toBe(`${ORIGIN}/home?token=${FRESH_TOKEN}`)
    } finally {
      Reflect.deleteProperty(window.history, 'replaceState')
    }
  })

  // (b) SSR/non-browser early-return guard. jsdom always defines a global
  // `window`, so `typeof window === 'undefined'` is unreachable from inside
  // a jsdom test. The sibling clause on the same guard line —
  // `typeof window.localStorage === 'undefined'` — *is* reachable: jsdom
  // defines `localStorage` as a configurable accessor, so we can mask it to
  // `undefined` to drive the early return, then restore the original
  // descriptor.
  test('no-op when localStorage is unavailable (non-browser guard)', () => {
    setLocation(`/home?token=${FRESH_TOKEN}`)
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
    if (originalDescriptor === undefined) {
      throw new Error('expected window.localStorage to be an own property in jsdom')
    }
    Object.defineProperty(window, 'localStorage', { value: undefined, configurable: true })

    try {
      expect(() => {
        consumeUrlTokenIntoLocalStorage()
      }).not.toThrow()

      // URL untouched: the function bailed before stripping `?token=`.
      expect(window.location.href).toBe(`${ORIGIN}/home?token=${FRESH_TOKEN}`)
    } finally {
      Object.defineProperty(window, 'localStorage', originalDescriptor)
    }
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
  // Each `vi.resetModules()` + re-import re-runs `token-storage`'s
  // load-time `window.addEventListener('storage', ...)`, leaking an
  // anonymous handler. The handler isn't exported, so we spy on
  // `addEventListener` *before* each re-import (the default `vi.spyOn`
  // still calls through, so the real listener registers) and read the
  // recorded `'storage'` handlers off the spy. `afterEach` detaches each
  // one, otherwise leaked listeners fire against a torn-down ref in later
  // tests.
  let addEventListenerSpy: MockInstance<typeof window.addEventListener> | undefined

  beforeEach(() => {
    window.localStorage.clear()
    setLocation('/')
    vi.resetModules()
    addEventListenerSpy = vi.spyOn(window, 'addEventListener')
  })

  afterEach(() => {
    for (const [type, listener] of addEventListenerSpy?.mock.calls ?? []) {
      if (type === 'storage') {
        window.removeEventListener('storage', listener)
      }
    }
    addEventListenerSpy?.mockRestore()
    window.localStorage.clear()
    setLocation('/')
    vi.resetModules()
  })

  test('authTokenRef is seeded from ?token= on module load', async () => {
    setLocation(`/home?token=${FRESH_TOKEN}`)

    const reloaded: typeof TokenStorageType = await import('./token-storage.ts')

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

    const reloaded: typeof TokenStorageType = await import('./token-storage.ts')

    const initial = await Effect.runPromise(SubscriptionRef.get(reloaded.authTokenRef))
    expect(initial).toBe(FRESH_TOKEN)
  })
})
