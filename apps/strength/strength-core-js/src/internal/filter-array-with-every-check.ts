import { Schema } from 'effect'

/** A check on an array's elements, returning its issues as a `Schema.filter` predicate does. */
type ArrayElementsCheck<A> = (elements: readonly A[]) => Schema.FilterOutput

/** A filter an array schema is piped through, keeping its type. */
type ArrayFilter<A> = <I, R>(
  self: Schema.Schema<readonly A[], I, R>
) => Schema.Schema<readonly A[], I, R>

/**
 * Filters an array through every one of `checks` as one refinement, reporting
 * every check's issues.
 *
 * @remarks
 * One refinement rather than one `Schema.filter` per check: Effect runs a
 * filter only once the one beneath it passes, so an array that must hold one
 * `sets` and one `reps` concept would name a bad `sets` and never reach the
 * bad `reps`. A single check pipes as `Schema.filter(check)`.
 */
const filterArrayWithEveryCheck = <A>(checks: readonly ArrayElementsCheck<A>[]): ArrayFilter<A> =>
  Schema.filter((elements: readonly A[]) => checks.map((check) => check(elements)))

export { filterArrayWithEveryCheck }
export type { ArrayElementsCheck, ArrayFilter }
