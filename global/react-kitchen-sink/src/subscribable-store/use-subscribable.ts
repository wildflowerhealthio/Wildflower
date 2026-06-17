import { Effect, Fiber, Stream, type Subscribable } from 'effect'
import { useCallback, useSyncExternalStore } from 'react'

/**
 * Subscribe to an Effect {@link Subscribable.Subscribable} from React.
 * Re-renders on every change; reads the current value synchronously
 * via `Subscribable.get`.
 *
 * Bridges `Subscribable.changes` (an Effect `Stream`) to React's
 * `useSyncExternalStore` via a one-shot forked fiber per subscribe.
 * The fiber emits the replayed initial value too — React's snapshot
 * equality drops the redundant re-render for the same value.
 *
 * `subscribe`/`getSnapshot` are memoised on the `subscribable` identity
 * so React doesn't tear down and re-fork the underlying fiber every
 * parent re-render. The interrupt uses `Fiber.interruptFork`, the
 * canonical sync "fire-and-forget" form matching React's cleanup
 * contract (which doesn't await).
 */
const useSubscribable = <T>(subscribable: Subscribable.Subscribable<T>): T => {
  const subscribe = useCallback(
    (notify: () => void) => {
      const fiber = Effect.runFork(
        Stream.runForEach(subscribable.changes, () => Effect.sync(notify))
      )
      return () => {
        Effect.runFork(Fiber.interruptFork(fiber))
      }
    },
    [subscribable]
  )
  const getSnapshot = useCallback(() => Effect.runSync(subscribable.get), [subscribable])
  return useSyncExternalStore(subscribe, getSnapshot)
}

export { useSubscribable }
