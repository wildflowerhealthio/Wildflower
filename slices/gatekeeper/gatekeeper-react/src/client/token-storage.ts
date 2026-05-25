/**
 * Module-scoped `SubscriptionRef<string | null>` for the gatekeeper
 * bearer token. Single source of truth at runtime; localStorage is the
 * persistence backstop.
 *
 * Lifecycle:
 *   1. At module load, read the initial value from `localStorage`.
 *   2. Create the SubscriptionRef with that value.
 *   3. Fork a subscription to `ref.changes` that writes every subsequent
 *      value back to `localStorage` (the first emission — the initial
 *      value we just read — is dropped to avoid the redundant write).
 *   4. In browsers, attach a `window.storage` listener so cross-tab
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

const readInitialToken = (): string | null => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return null
  return window.localStorage.getItem(TOKEN_STORAGE_KEY)
}

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

/**
 * Module-scoped flag indicating the embedding host has committed to
 * delivering an `AuthTokenIssued` via the gatekeeper bridge. Initialized
 * `false`; flipped to `true` by `gatekeeperWebReceiverLayer` when a
 * `WaitForToken` bridge message arrives.
 *
 * `WaitForToken` rides URL params, and `TransportProvider` blocks the
 * descendant tree until `transport.flushed` resolves — so subscribers
 * see the post-handshake value on first read. The auth gate consults
 * this to decide whether to render a neutral loader (host present) vs.
 * the device-flow UI (truly standalone) when no token is present yet.
 */
const waitForHostTokenRef: SubscriptionRef.SubscriptionRef<boolean> = Effect.runSync(
  SubscriptionRef.make(false)
)

export { TOKEN_STORAGE_KEY, authTokenRef, waitForHostTokenRef, writeToken }
