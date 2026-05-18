import type { DeepReadonly } from './types/deep-readonly.ts'

/**
 * Recursively `Object.freeze` `value` and every nested plain object /
 * array reachable from it, returning the same reference with a
 * `DeepReadonly<T>` type.
 *
 * @remarks
 * - Idempotent — already-frozen subgraphs are left alone, so cycles
 *   terminate.
 * - Functions are not recursed into; their `prototype` /
 *   `arguments` / etc. surface is uninteresting at the freeze
 *   boundary. `Object.freeze` is still applied to the function value
 *   itself so reassignment of own properties on the function fails.
 * - Primitives (`string`, `number`, `boolean`, `null`, `undefined`,
 *   `bigint`, `symbol`) pass through unchanged.
 * - Operates in place and returns the original reference — callers
 *   that want a snapshot independent of the original should clone
 *   before calling.
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
