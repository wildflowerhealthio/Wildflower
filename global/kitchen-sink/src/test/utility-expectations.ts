import type { Either } from 'effect'

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
  /**
   * Asserts `either` is a `Right` and its right value deep-equals `expected`.
   * `expected` is `unknown` so it accepts both literal values and asymmetric
   * matchers (e.g. `expect.objectContaining(...)`). Fails with a clear
   * "Expected Right, got Left" message on the wrong side.
   */
  readonly expectRightToEqual: <A, E>(either: Either.Either<A, E>, expected: unknown) => void
  /**
   * Asserts `either` is a `Left` and its left value deep-equals `expected`.
   * Mirror of {@link UtilityExpectations.expectRightToEqual} for error-path
   * assertions.
   */
  readonly expectLeftToEqual: <A, E>(either: Either.Either<A, E>, expected: unknown) => void
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
 *     messages: `expectToMultisetEqual` failed beats `[...].toEqual(...)`.
 *   - The `Either.isRight(x)` + `if (Either.isRight(x)) expect(x.right)…`
 *     ladder shows up everywhere; `expectRightToEqual` collapses it to
 *     one expression and gives a meaningful failure on Left.
 *
 * @example
 * ```ts
 * import { expect } from 'vite-plus/test'
 * import { utilityExpectations } from 'kitchen-sink/test'
 *
 * const { expectDistinct, expectToMultisetEqual, expectRightToEqual, expectLeftToEqual } =
 *   utilityExpectations(expect)
 *
 * test('every id is unique', () => {
 *   expectDistinct(events.map((e) => e.id))
 * })
 *
 * test('shipped + arrived have the same id set', () => {
 *   expectToMultisetEqual(shipped.map((s) => s.id), arrived.map((a) => a.id))
 * })
 *
 * test('decoded payload matches the input', () => {
 *   expectRightToEqual(parse(body), { name: 'Alice', age: 30 })
 *   expectLeftToEqual(parse('{not json}'), expect.objectContaining({ _tag: 'ParseError' }))
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
  expectRightToEqual: (either, expected) => {
    expect(either._tag).toBe('Right')
    if (either._tag === 'Right') {
      expect(either.right).toEqual(expected)
    }
  },
  expectLeftToEqual: (either, expected) => {
    expect(either._tag).toBe('Left')
    if (either._tag === 'Left') {
      expect(either.left).toEqual(expected)
    }
  },
})

export { utilityExpectations }
export type { Expect, ExpectMatchers, UtilityExpectations }
