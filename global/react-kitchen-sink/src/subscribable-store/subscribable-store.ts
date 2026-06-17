import { Effect, type Subscribable, SubscriptionRef } from 'effect'

/**
 * The pair every "single mutable cell observed by both Effect and React
 * consumers" store in this codebase had grown by hand: a `Subscribable`
 * read side and a synchronous `set` write side. Specialise it for the
 * domain by destructuring and renaming the setter (e.g.
 * `{ subscribable, set: setToken }`) to keep the public surface
 * domain-specific while sharing the plumbing.
 *
 * The setter is synchronous — `SubscriptionRef.set` runs the change
 * effect inline — but `subscribable.changes` notifications fire on the
 * next microtask, so a `set(...)` immediately followed by a
 * `runForEach`-driven observer needs a `await Promise.resolve()` (or
 * equivalent flush) between them in tests.
 */
interface SubscribableStore<T> {
  /**
   * Live current value. Effect consumers read via `Subscribable.get`;
   * React consumers observe `subscribable.changes` for invalidation.
   */
  readonly subscribable: Subscribable.Subscribable<T>
  /**
   * Replace the current value. Synchronous side-effect.
   */
  readonly set: (value: T) => void
}

/**
 * Build a {@link SubscribableStore}: a `SubscriptionRef<T>` seeded with
 * `initial`, plus a synchronous setter that writes through to it.
 *
 * @example
 * ```ts
 * const { subscribable, set: setToken } =
 *   makeSubscribableStore<string | null>(null)
 * ```
 */
const makeSubscribableStore = <T>(initial: T): SubscribableStore<T> => {
  const ref = Effect.runSync(SubscriptionRef.make<T>(initial))
  return {
    subscribable: ref,
    set: (value) => Effect.runSync(SubscriptionRef.set(ref, value)),
  }
}

export { makeSubscribableStore }
export type { SubscribableStore }
