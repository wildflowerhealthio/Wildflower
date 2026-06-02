/**
 * Module-scoped `SubscriptionRef<string | null>` for the gatekeeper
 * bearer token. Single source of truth at runtime; localStorage is the
 * persistence backstop.
 *
 * Lifecycle:
 *   1. At module load, consume any `?token=` URL parameter into
 *      `localStorage` (and strip it from the address bar). This is the
 *      dev-mode bootstrap path documented in gatekeeper-core's README —
 *      `wildflower-node` logs `<origin>/home?token=<token>` on startup;
 *      pasting that URL into a browser lands the token in storage before
 *      the auth gate reads it. Runs before step 2 so a freshly-pasted
 *      bootstrap URL wins over a stale localStorage value.
 *   2. Read the initial value from `localStorage`.
 *   3. Create the SubscriptionRef with that value.
 *   4. Fork a subscription to `ref.changes` that writes every subsequent
 *      value back to `localStorage` (the first emission — the initial
 *      value we just read — is dropped to avoid the redundant write).
 *   5. In browsers, attach a `window.storage` listener so cross-tab
 *      writes propagate into the ref. The listener guards against
 *      feedback loops by comparing the current ref value before
 *      writing.
 *
 * Consumers:
 *   - React tree: `<AuthTokenProvider subscribable={authTokenRef}>`
 *     from `react-kitchen-sink`; descendants call `useAuthToken()` or
 *     `useAuthTokenSubscribable()`.
 *   - Effect side: provided as `BearerToken` via
 *     `Layer.succeed(BearerToken, authTokenRef)` so client layers can
 *     read the token from inside an `HttpClient.mapRequestEffect`
 *     transform.
 *   - Writers (`NeedsAuthMessage`, `web-bridge`): call {@link writeToken}
 *     or `Effect.runSync(SubscriptionRef.set(authTokenRef, token))`.
 */

import { Effect, Stream, SubscriptionRef } from 'effect'

const TOKEN_STORAGE_KEY = 'gatekeeper:token'

/**
 * Dev-mode bootstrap: if the page was opened with a `?token=<value>`
 * query parameter, write it to `localStorage` under {@link TOKEN_STORAGE_KEY}
 * and strip the parameter from the address bar via `history.replaceState`
 * (so the token doesn't persist in browser history or Referer headers).
 *
 * Writes directly to `localStorage` rather than routing through
 * {@link writeToken} because this runs *before* `authTokenRef` is
 * constructed — the goal is for {@link readInitialToken} to pick up the
 * URL token as the ref's initial value.
 *
 * No-op outside the browser, when `?token=` is missing or empty, or when
 * `history.replaceState` is unavailable.
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

const readInitialToken = (): string | null => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return null
  return window.localStorage.getItem(TOKEN_STORAGE_KEY)
}

consumeUrlTokenIntoLocalStorage()

const authTokenRef: SubscriptionRef.SubscriptionRef<string | null> = Effect.runSync(
  SubscriptionRef.make(readInitialToken())
)

// Persist subsequent ref updates back to localStorage. `Stream.drop(1)`
// skips the initial emission (which is the value we just read from
// localStorage — re-writing it would be redundant I/O).
if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
  Effect.runFork(
    Stream.runForEach(Stream.drop(authTokenRef.changes, 1), (token) =>
      Effect.sync(() => {
        if (token === null) {
          window.localStorage.removeItem(TOKEN_STORAGE_KEY)
        } else {
          window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
        }
      })
    )
  )

  // Cross-tab: when another tab writes, mirror into the ref. The
  // current-value guard avoids the local persistence subscription
  // writing the same value back (which would no-op in localStorage but
  // still dispatch a needless ref change).
  window.addEventListener('storage', (event) => {
    if (event.key !== TOKEN_STORAGE_KEY) return
    const incoming = event.newValue
    Effect.runFork(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(authTokenRef)
        if (current !== incoming) {
          yield* SubscriptionRef.set(authTokenRef, incoming)
        }
      })
    )
  })
}

/**
 * Write the bearer token. Mirrors the historical `writeToken(token: string)`
 * API but routes through {@link authTokenRef} so subscribers (React
 * components via `<AuthTokenProvider>` and Effect-side `BearerToken` consumers)
 * see the rotation, and localStorage is updated via the changes-stream
 * subscription.
 *
 * Passing `null` clears the token.
 */
const writeToken = (token: string | null): void => {
  Effect.runSync(SubscriptionRef.set(authTokenRef, token))
}

export { TOKEN_STORAGE_KEY, authTokenRef, consumeUrlTokenIntoLocalStorage, writeToken }
