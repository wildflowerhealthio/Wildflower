/**
 * Per-entry {@link AuthTokenStore} factories for the gatekeeper bearer
 * token: {@link makeWebAuthTokenStore} (`localStorage`-backed, for the
 * standalone web entries) and {@link makeEmbeddedAuthTokenStore}
 * (in-memory only, for the in-WebView SPA). Both return the same
 * {@link AuthTokenStore} shape so every consumer is environment-blind;
 * only the `main-*` entrypoint picks a factory.
 *
 * See `slices/gatekeeper/docs/Auth Token Storage Explanation.md` for
 * the storage-policy rationale (why the embedded store ignores
 * `localStorage`, and why the URL token is JWT-shape validated).
 */

import { Effect, SubscriptionRef } from 'effect'
import { makeSubscribableStore, type AuthTokenStore } from 'react-kitchen-sink'

const TOKEN_STORAGE_KEY = 'gatekeeper:token'

/**
 * A bearer token must look like a JWT before we persist it: exactly
 * three non-empty base64url segments separated by dots. The `?token=`
 * value is attacker-controllable, so a malformed value must not
 * clobber a previously-valid stored token.
 */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

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
 * The URL token is validated against {@link JWT_SHAPE} before being
 * persisted. A value that fails validation is treated as if no usable
 * token was supplied: the existing stored token is left untouched, but
 * the `?token=` param is still stripped from the address bar (matching
 * the success path) so the malformed value doesn't linger in history
 * or Referer headers.
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
  if (JWT_SHAPE.test(tokenFromUrl)) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, tokenFromUrl)
  }
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
 * Build the standalone-web {@link AuthTokenStore}: a `SubscriptionRef`
 * seeded from `localStorage` (after consuming any `?token=…` URL
 * bootstrap), whose `setToken` writes through to both the ref and
 * `localStorage`, with a `'storage'` listener mirroring cross-tab
 * writes. Call once per page load in the `main-*` entrypoint before
 * `renderApp`. See the Auth Token Storage Explanation for the policy
 * details.
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
 * Used by `main-embedded`; see the Auth Token Storage Explanation for
 * why this store ignores `localStorage`.
 */
const makeEmbeddedAuthTokenStore = (): AuthTokenStore => {
  const { subscribable, set: setToken } = makeSubscribableStore<string | null>(null)
  return { subscribable, setToken }
}

export {
  consumeUrlTokenIntoLocalStorage,
  makeEmbeddedAuthTokenStore,
  makeWebAuthTokenStore,
  TOKEN_STORAGE_KEY,
}
