import { Effect, Fiber, Stream } from 'effect'
import { useCallback, useSyncExternalStore } from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

import { ActiveDeviceRequestContext } from './active-device-request-context.ts'

/**
 * Returns the live active device-consent `userCode` (or `null`) from the
 * nearest `<ActiveDeviceRequestProvider>`, re-rendering the caller
 * whenever the head changes. Throws when no provider is in the tree.
 *
 * Bridges the store's `Subscribable` to React via `useSyncExternalStore`:
 *
 *  - `getSnapshot` reads the current value synchronously through
 *    `subscribable.get` (a `Subscribable` exposes `.get` as an
 *    `Effect<T>` directly).
 *  - `subscribe` forks a fiber draining `subscribable.changes` and calls
 *    `onStoreChange` on every emission. The cleanup interrupts the fiber.
 *
 * We deliberately do *not* drop the `SubscriptionRef`'s replay-the-current-
 * value emission: the fork runs asynchronously, so a write that lands
 * before the fiber subscribes would be folded into that replay. Dropping it
 * would then swallow the only notify for that write and the caller would
 * never re-render. Forwarding the replay instead is harmless — the snapshot
 * is a primitive, so `useSyncExternalStore` skips the re-render by value
 * equality when nothing actually changed, and re-renders when it did.
 */
const useActiveDeviceRequest = (): string | null => {
  const { subscribable } = useContextOrThrow(ActiveDeviceRequestContext)

  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      const fiber = Effect.runFork(
        Stream.runForEach(subscribable.changes, () => Effect.sync(onStoreChange))
      )
      return () => {
        Effect.runFork(Fiber.interrupt(fiber))
      }
    },
    [subscribable]
  )

  const getSnapshot = useCallback(
    (): string | null => Effect.runSync(subscribable.get),
    [subscribable]
  )

  return useSyncExternalStore(subscribe, getSnapshot)
}

export { useActiveDeviceRequest }
