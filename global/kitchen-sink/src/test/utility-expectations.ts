import type { Either } from 'effect'

/**
 * Minimal subset of an `expect` matcher chain — just the two members the
 * surrounding {@link Expect} type needs. The type is structural, so it accepts
 * Vitest's `expect` or any other shape-compatible surface.
 */
interface ExpectMatchers {
  readonly toBe: (expected: unknown) => unknown
  readonly toEqual: (expected: unknown) => unknown
}

/**
 * Minimal call signature of `expect` itself — both the function-call form
 * and the `expect.objectContaining` asymmetric-matcher constructor we use
 * to tolerate Effect's prototype-resident `_tag` field. Vitest's `expect`
 * exposes this shape.
 */
type Expect = ((actual: unknown) => ExpectMatchers) & {
  readonly objectContaining: (spec: Record<string, unknown>) => unknown
}

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
   * matchers (e.g. `expect.objectContaining(...)`). Implemented as a single
   * `toEqual` against `expect.objectContaining({ _tag: 'Right', right: expected })`
   * so a failure surfaces the whole `Either` in the diff — not just one
   * branch of a two-step `isRight` + `.right.toEqual` ladder. `objectContaining`
   * is required because `Either` carries `_tag` on its prototype, not as an
   * own enumerable property; a strict literal `toEqual` would fail the key-set
   * check.
   */
  readonly expectRightToEqual: <A, E>(either: Either.Either<A, E>, expected: unknown) => void
  /**
   * Asserts `either` is a `Left` and its left value deep-equals `expected`.
   * Mirror of {@link UtilityExpectations.expectRightToEqual} for error-path
   * assertions; same single-`toEqual` failure-diff property and same
   * `objectContaining` rationale (`_tag` is prototype-resident).
   */
  readonly expectLeftToEqual: <A, E>(either: Either.Either<A, E>, expected: unknown) => void
}

/**
 * Build a small set of reusable expectation helpers parameterized by
 * the test framework's `expect`. Pass `expect` from `vite-plus/test`
 * (Vitest) or any other shape-compatible surface; the structural type
 * accepts each.
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
    // Single `toEqual` against the tagged-object shape. On a Left input,
    // the failure diff is the whole `either` (tag + payload) against the
    // expected `objectContaining({ _tag: 'Right', right: <expected> })`,
    // not just a stray `'Left' !== 'Right'` from a discarded preliminary
    // check.
    //
    // `objectContaining` (rather than a strict literal) is required
    // because an `Either` only carries `right` (or `left`) as an own
    // enumerable property — `_tag` lives on the prototype. The fuzzy
    // match reads `_tag` through the prototype chain while still
    // failing on a wrong tag or wrong payload.
    expect(either).toEqual(expect.objectContaining({ _tag: 'Right', right: expected }))
  },
  expectLeftToEqual: (either, expected) => {
    expect(either).toEqual(expect.objectContaining({ _tag: 'Left', left: expected }))
  },
})

export { utilityExpectations }
export type { Expect, ExpectMatchers, UtilityExpectations }
