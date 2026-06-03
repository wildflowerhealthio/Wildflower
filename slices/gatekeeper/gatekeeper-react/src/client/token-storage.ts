/**
 * Per-entry {@link AuthTokenStore} factories for the gatekeeper
 * bearer token. Replaces an older module-scoped `SubscriptionRef` +
 * `writeToken` pair — the singleton couldn't honestly represent two
 * different storage policies (localStorage-persistent for standalone
 * web, in-memory-only for the embedded WebView), so the entrypoint
 * that knows which environment it's in now constructs the store and
 * threads it through `renderApp`.
 *
 * Both factories return the same {@link AuthTokenStore} shape so
 * `AuthTokenProvider`, the `BearerToken` Layer, the page-bridge
 * `AuthTokenIssued` handler, and the `auth-ready` gates are all
 * environment-blind — only the entrypoint chooses behavior.
 *
 * Storage policies:
 *
 *  - {@link makeWebAuthTokenStore} — `localStorage`-backed. Reads the
 *    initial value at construction time, persists every subsequent
 *    write back, mirrors cross-tab writes via the
 *    `'storage'` event, and consumes any `?token=…` URL bootstrap
 *    parameter into `localStorage` (the standalone dev flow
 *    `wildflower-node` logs at startup). Used by `main-web` /
 *    `main-single-web`.
 *  - {@link makeEmbeddedAuthTokenStore} — in-memory only, initial
 *    value `null`. The embedded WebView's `WKWebsiteDataStore`
 *    outlives the host's JS context (Metro reload and, depending on
 *    iOS policy, even force-kill leave the previous session's token
 *    in storage). The LHS daemon mints a fresh token and re-pushes it
 *    on every boot via the gatekeeper bridge, so a `localStorage`-
 *    cached value can only ever be stale and racing the host's fresh
 *    push leaves TanStack Query loaders pinned on 401s. Used by
 *    `main-embedded`.
 */

import { Effect, SubscriptionRef } from 'effect'
import type { AuthTokenStore } from 'react-kitchen-sink'

const TOKEN_STORAGE_KEY = 'gatekeeper:token'

/**
 * Dev-mode bootstrap: if the page was opened with a `?token=<value>`
 * query parameter, write it to `localStorage` under
 * {@link TOKEN_STORAGE_KEY} and strip the parameter from the address
 * bar via `history.replaceState` (so the token doesn't persist in
 * browser history or Referer headers).
 *
 * Writes directly to `localStorage` rather than going through any
 * store API because this runs *before* a store is constructed — the
 * goal is for the subsequent `localStorage.getItem` call inside
 * {@link makeWebAuthTokenStore} to pick the URL token up as the
 * store's initial value.
 *
 * No-op outside the browser, when `?token=` is missing or empty, or
 * when `history.replaceState` is unavailable.
 *
 * Exported for tests; called automatically by
 * {@link makeWebAuthTokenStore}.
 */
const consumeUrlTokenIntoLocalStorage = (): void => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return
  if (typeof window.history === 'undefined' || typeof window.history.replaceState !== 'function') {
    return
  }
  const url = new URL(window.location.href)
  const tokenFromUrl = url.searchParams.get('token')
  if (tokenFromUrl === null || tokenFromUrl === '') return
  window.localStorage.setItem(TOKEN_STORAGE_KEY, tokenFromUrl)
  url.searchParams.delete('token')
  window.history.replaceState(null, '', url.toString())
}

const readInitialTokenFromLocalStorage = (): string | null => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return null
  return window.localStorage.getItem(TOKEN_STORAGE_KEY)
}

/**
 * Persist a single token write into `localStorage`. Module-private —
 * the only writer is {@link makeWebAuthTokenStore}'s returned
 * `setToken`, so persistence runs synchronously alongside the ref
 * update; no forked subscriber, no microtask gap between
 * `setToken(...)` and the value being visible in `localStorage`.
 */
const writeTokenToLocalStorage = (token: string | null): void => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return
  if (token === null) {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY)
  } else {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
  }
}

/**
 * Build the standalone-web {@link AuthTokenStore}:
 *
 *  1. Consume any `?token=…` URL bootstrap into `localStorage` (see
 *     {@link consumeUrlTokenIntoLocalStorage}).
 *  2. Construct the underlying `SubscriptionRef` seeded with the
 *     current `localStorage` value.
 *  3. Returned `setToken` writes through to both the ref AND
 *     `localStorage` in one synchronous step. Anything subscribed to
 *     `subscribable.changes` sees the update; the next page load /
 *     other tab reads the new value back via
 *     `readInitialTokenFromLocalStorage`.
 *  4. Attach a `'storage'` event listener so cross-tab writes
 *     propagate into the ref; a current-value guard avoids the listener
 *     storming the ref with the same value when this tab is the writer
 *     (browsers don't fire `'storage'` on the writing tab, but the
 *     guard hardens the contract against future spec relaxations and
 *     against any future code path that calls `localStorage.setItem`
 *     outside `setToken`).
 *
 * Call once per page load (web entries do this in their `main-*`
 * entrypoint before `renderApp`).
 */
const makeWebAuthTokenStore = (): AuthTokenStore => {
  consumeUrlTokenIntoLocalStorage()

  const ref = Effect.runSync(SubscriptionRef.make(readInitialTokenFromLocalStorage()))

  if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== TOKEN_STORAGE_KEY) return
      const incoming = event.newValue
      Effect.runFork(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(ref)
          if (current !== incoming) {
            yield* SubscriptionRef.set(ref, incoming)
          }
        })
      )
    })
  }

  return {
    subscribable: ref,
    setToken: (token) => {
      Effect.runSync(SubscriptionRef.set(ref, token))
      writeTokenToLocalStorage(token)
    },
  }
}

/**
 * Build the embedded-WebView {@link AuthTokenStore}: a
 * `SubscriptionRef<string | null>` seeded with `null`, no
 * `localStorage` read, no persistence subscriber, no cross-tab
 * listener. The host's `AuthTokenIssued` handler is the sole writer.
 *
 * Used by `main-embedded`; see the {@link AuthTokenStore} docstring
 * for the why.
 */
const makeEmbeddedAuthTokenStore = (): AuthTokenStore => {
  const ref = Effect.runSync(SubscriptionRef.make<string | null>(null))
  return {
    subscribable: ref,
    setToken: (token) => Effect.runSync(SubscriptionRef.set(ref, token)),
  }
}

export {
  consumeUrlTokenIntoLocalStorage,
  makeEmbeddedAuthTokenStore,
  makeWebAuthTokenStore,
  TOKEN_STORAGE_KEY,
}
