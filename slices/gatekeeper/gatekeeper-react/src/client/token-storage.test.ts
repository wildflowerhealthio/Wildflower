import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import {
  consumeUrlTokenIntoLocalStorage,
  makeEmbeddedAuthTokenStore,
  makeWebAuthTokenStore,
  TOKEN_STORAGE_KEY,
} from './token-storage.ts'

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

// JWT-shaped (three base64url segments) so it passes the `JWT_SHAPE`
// guard inside `consumeUrlTokenIntoLocalStorage`.
const FRESH_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.s1g-n4tur3_xyz'

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

  test('rejects a malformed ?token= but still strips it from the URL', () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, FRESH_TOKEN)
    setLocation('/home?token=not-a-jwt')

    consumeUrlTokenIntoLocalStorage()

    // The attacker-controllable malformed value must not clobber the
    // previously-valid stored token...
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(FRESH_TOKEN)
    // ...but the param is still stripped so it can't linger in history.
    expect(window.location.href).toBe(`${ORIGIN}/home`)
  })

  test('rejects a ?token= with too few segments', () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, FRESH_TOKEN)
    setLocation('/home?token=only.two')

    consumeUrlTokenIntoLocalStorage()

    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(FRESH_TOKEN)
    expect(window.location.href).toBe(`${ORIGIN}/home`)
  })

  test('rejects an encoding-sensitive ?token= (space/plus) but still strips it', () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, FRESH_TOKEN)
    // `a b+c` carries a space and a `+` (which the query decoder turns
    // into another space) — it can't match the three-segment base64url
    // shape, so a crafted link with junk like this must not clobber the
    // stored bearer.
    setLocation('/home?token=a b+c')

    consumeUrlTokenIntoLocalStorage()

    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(FRESH_TOKEN)
    expect(window.location.href).toBe(`${ORIGIN}/home`)
  })
})

/**
 * `makeWebAuthTokenStore()` calls `consumeUrlTokenIntoLocalStorage`
 * before constructing the underlying `SubscriptionRef`, so a
 * `?token=…` painted on the URL at construction time should land as
 * the store's initial value (with `localStorage` holding it and the
 * URL stripped). This is what `webAuthReadyEffect` resolves against
 * instead of redirecting on first paint.
 */
describe('makeWebAuthTokenStore', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setLocation('/')
  })

  afterEach(() => {
    window.localStorage.clear()
    setLocation('/')
  })

  test('seeds the store from ?token= on construction', async () => {
    setLocation(`/home?token=${FRESH_TOKEN}`)

    const store = makeWebAuthTokenStore()

    // URL was stripped at construction time
    expect(window.location.href).toBe(`${ORIGIN}/home`)
    // localStorage holds the URL token
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(FRESH_TOKEN)
    // The store's subscribable picked up the URL token as its initial value
    const initial = await Effect.runPromise(store.subscribable.get)
    expect(initial).toBe(FRESH_TOKEN)
  })

  test('?token= wins over a stale localStorage value at construction', async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'stale-token')
    setLocation(`/home?token=${FRESH_TOKEN}`)

    const store = makeWebAuthTokenStore()

    const initial = await Effect.runPromise(store.subscribable.get)
    expect(initial).toBe(FRESH_TOKEN)
  })

  test('persists subsequent setToken writes back to localStorage synchronously', () => {
    const store = makeWebAuthTokenStore()
    store.setToken('written-via-setter')
    // `setToken` writes to the ref AND `localStorage` in the same
    // synchronous step — no microtask flush required.
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('written-via-setter')
  })

  test('clearing the token via setToken(null) removes the localStorage key synchronously', () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'seeded')
    const store = makeWebAuthTokenStore()
    store.setToken(null)
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(null)
  })
})

/**
 * The embedded store ignores `localStorage` entirely on both reads
 * and writes — the host bridge is the sole writer. A stale value left
 * by a previous WebView session must NEVER surface as the embedded
 * store's initial value (the auth-ready gate would otherwise resolve
 * with a stale bearer and TanStack Query would pin 401s in cache).
 */
describe('makeEmbeddedAuthTokenStore', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  test('starts at null even when localStorage holds a stale token', async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'stale-from-previous-session')

    const store = makeEmbeddedAuthTokenStore()

    const initial = await Effect.runPromise(store.subscribable.get)
    expect(initial).toBe(null)
  })

  test('does not write to localStorage on setToken (in-memory only)', async () => {
    const store = makeEmbeddedAuthTokenStore()
    store.setToken('from-host-bridge')
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(null)
    // The store itself reflects the write — the localStorage skip is
    // policy, not a no-op.
    const after = await Effect.runPromise(store.subscribable.get)
    expect(after).toBe('from-host-bridge')
  })
})
