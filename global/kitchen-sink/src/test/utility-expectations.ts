/**
 * Minimal subset of an `expect` matcher chain — the two members below
 * exist on both Vitest's and Jest's `expect`, so the surrounding
 * {@link Expect} type accepts either framework structurally.
 */
interface ExpectMatchers {
  readonly toBe: (expected: unknown) => unknown
  readonly toEqual: (expected: unknown) => unknown
}

/**
 * Minimal call signature of `expect` itself. Vitest's
 * `<T>(actual: T): Assertion<T>` and Jest's `<T>(actual: T): Matchers<T>`
 * both fit — `Assertion` / `Matchers` are wider than {@link ExpectMatchers},
 * but the structural assignment works because we only call methods that
 * are common to both.
 */
type Expect = (actual: unknown) => ExpectMatchers

/** The expectation surface returned by {@link utilityExpectations}. */
interface UtilityExpectations {
  /**
   * Asserts every value in `values` is distinct (no duplicates by SameValueZero,
   * the semantics of `Set`).
   */
  readonly expectDistinct: (values: readonly unknown[]) => void
  /**
   * Asserts `actual` and `expected` have the same elements, order-insensitive
   * (multiset equality). Elements are sorted via JavaScript's default
   * stringifying `.sort()` before comparison — order is incidental, but the
   * resulting equality is preserved for any `T` whose stringification is
   * unique within the array.
   */
  readonly expectToMultisetEqual: <T>(actual: readonly T[], expected: readonly T[]) => void
}

/**
 * Build a small set of reusable expectation helpers parameterized by
 * the test framework's `expect`. Pass `expect` from `vite-plus/test`
 * (Vitest), `@jest/globals` (Jest), or any other shape-compatible
 * surface; the structural type accepts each.
 *
 * The helpers exist because the underlying patterns are hard to read
 * spelled out at every call site:
 *
 *   - `expect(new Set(ids).size).toBe(ids.length)` is more boilerplate
 *     than the intent ("no duplicate ids") deserves.
 *   - `expect([...a].toSorted()).toEqual([...b].toSorted())` is fine,
 *     but a named `expectToMultisetEqual` shows up clearly in failure
 *     messages: `expectToMultisetEqual` failed > `[...].toEqual(...)`.
 *
 * @example
 * ```ts
 * import { expect } from 'vite-plus/test'
 * import { utilityExpectations } from 'kitchen-sink/test'
 *
 * const { expectDistinct, expectToMultisetEqual } = utilityExpectations(expect)
 *
 * test('every id is unique', () => {
 *   expectDistinct(events.map((e) => e.id))
 * })
 *
 * test('shipped + arrived have the same id set', () => {
 *   expectToMultisetEqual(shipped.map((s) => s.id), arrived.map((a) => a.id))
 * })
 * ```
 */
const utilityExpectations = (expect: Expect): UtilityExpectations => ({
  expectDistinct: (values) => {
    expect(new Set(values).size).toBe(values.length)
  },
  expectToMultisetEqual: (actual, expected) => {
    // oxlint-disable-next-line typescript-eslint/require-array-sort-compare -- default lexical sort is intentional; multiset equality only requires deterministic order
    expect([...actual].toSorted()).toEqual([...expected].toSorted())
  },
})

export { utilityExpectations }
export type { Expect, ExpectMatchers, UtilityExpectations }
