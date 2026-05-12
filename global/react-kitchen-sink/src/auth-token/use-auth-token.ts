import { Effect, Fiber, Stream } from 'effect'
import { useSyncExternalStore } from 'react'

import { useAuthTokenSubscribable } from './use-auth-token-subscribable.ts'

const noToken = (): null => null

/**
 * Read the current bearer token from the nearest `<AuthTokenProvider>`,
 * subscribing for re-renders on rotation. Equivalent to
 * `useSyncExternalStore` over the provider's `Subscribable`:
 *
 * - `getSnapshot` runs the Subscribable's `get` Effect synchronously
 *   (safe because the SubscriptionRef-backed instances we use have
 *   `R = never`, `E = never`).
 * - `subscribe` forks the Subscribable's `changes` stream and calls
 *   `notify` on every emission; cleanup interrupts the fiber.
 *
 * For components that need the Subscribable itself (e.g. to feed
 * into a `bearerTokenLayer`), use {@link useAuthTokenSubscribable}.
 */
const useAuthToken = (): string | null => {
  const subscribable = useAuthTokenSubscribable()
  return useSyncExternalStore(
    (notify) => {
      const fiber = Effect.runFork(
        Stream.runForEach(subscribable.changes, () => Effect.sync(notify))
      )
      return (): void => {
        void Effect.runPromise(Fiber.interrupt(fiber))
      }
    },
    () => Effect.runSync(subscribable.get),
    noToken
  )
}

export { useAuthToken }
