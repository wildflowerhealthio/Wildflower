import type { DeepReadonly } from './types/deep-readonly.ts'

/**
 * Recursively `Object.freeze` `value` and every nested plain object /
 * array reachable from it, returning the same reference with a
 * `DeepReadonly<T>` type.
 *
 * @remarks
 * - Idempotent — already-frozen subgraphs are left alone, so cycles
 *   terminate.
 * - A function reached through the graph (a callback field, say) is
 *   left alone: neither frozen nor recursed into, so a shared function
 *   the caller handed in is not mutated. A function passed as `value`
 *   itself is frozen like an object.
 * - Primitives (`string`, `number`, `boolean`, `null`, `undefined`,
 *   `bigint`, `symbol`) pass through unchanged.
 * - Operates in place and returns the original reference — callers
 *   that want a snapshot independent of the original should clone
 *   before calling.
 *
 * **Do not freeze a graph that holds branded / prototype-bearing library
 * values** — Effect `Duration` / `Option` / `Either` instances, `RegExp`,
 * class instances. `deepFreeze` recurses through _own enumerable keys_, so it
 * does not stop at a value that merely looks opaque: an Effect `Duration` has
 * an own enumerable `value`, so it gets frozen and recursed into. That is
 * harmless for an instance built at the call site, but library singletons
 * handed out by reference — `Duration.infinity`, `Duration.zero` — are shared
 * process-wide, and freezing one here mutates the value every other holder in
 * the process sees. The damage is delayed and reads as unrelated to freezing:
 * `Duration`'s `Hash` implementation memoises onto the instance with
 * `Object.defineProperty`, which throws `TypeError` on a frozen object, so
 * some later, entirely separate `Hash.hash` / `Equal` / `HashMap` use of that
 * singleton blows up. (Freezing a `RegExp` has its own bite: `lastIndex`
 * becomes unwritable, so a `/g` regex's `exec` throws.) Nothing fails at freeze
 * time and `vp check` stays green, which is what makes it hard to trace back.
 * Freeze plain data only; if a graph legitimately carries such values, skip
 * them at the freeze boundary rather than narrowing this utility for every
 * caller — e.g. a caller-side freeze that skips `Duration.isDuration` values
 * while still freezing the objects that hold them.
 *
 * Typical use: an identity factory:
 * `Foo.make(config) => deepFreeze({ ...config })`
 * that wants to hand its caller an immutable value without paying for
 * a clone on every read.
 */
const deepFreeze = <T>(value: T): DeepReadonly<T> => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return value as DeepReadonly<T>
  }
  if (Object.isFrozen(value)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return value as DeepReadonly<T>
  }
  Object.freeze(value)
  // `Object.entries` only walks own enumerable string keys (Symbols
  // and inherited props are skipped); good enough for the
  // identity-factory use case and avoids casting to
  // `Record<string, unknown>`.
  for (const [, child] of Object.entries(value as object)) {
    if (child !== null && typeof child === 'object') {
      deepFreeze(child)
    }
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as DeepReadonly<T>
}

export { deepFreeze }
