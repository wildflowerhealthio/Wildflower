import { Effect, Fiber, Stream } from 'effect'
import { useContext, useSyncExternalStore } from 'react'

import { ActiveDeviceUserCodeContext } from './context.ts'

/**
 * Subscribe to the active pending device-consent `user_code`.
 * Re-renders on every change. Throws when used outside an
 * `<ActiveDeviceUserCodeProvider>` — accidental consumers without a
 * wired store have no useful fallback.
 *
 * Bridges `Subscribable.changes` (an Effect `Stream`) to React's
 * `useSyncExternalStore` via a one-shot forked fiber per subscribe.
 * The fiber emits the replayed initial value too — React's snapshot
 * equality drops the redundant re-render for the same value, and
 * relying on the replay is what closes the boot race PR #142
 * documented (an async `Effect.runFork` subscribed *after* the first
 * write would otherwise drop it).
 */
const useActiveDeviceUserCode = (): string | null => {
  const store = useContext(ActiveDeviceUserCodeContext)
  if (store === null) {
    throw new Error('useActiveDeviceUserCode must be used inside <ActiveDeviceUserCodeProvider>')
  }
  return useSyncExternalStore(
    (notify) => {
      const fiber = Effect.runFork(
        Stream.runForEach(store.subscribable.changes, () => Effect.sync(notify))
      )
      return () => {
        Effect.runFork(Fiber.interrupt(fiber))
      }
    },
    () => Effect.runSync(store.subscribable.get)
  )
}

export { useActiveDeviceUserCode }
