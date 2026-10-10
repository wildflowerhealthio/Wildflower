import type * as Group from './group.ts'

/**
 * One discipline section of the results grid (`Hematology`, `Lipids`).
 *
 * @remarks
 * The fast-check `arbitrary` that lays a section out for tests lives in the
 * sibling `section-arbitrary.ts` (test-only).
 *
 * @packageDocumentation
 */

/** One discipline section of the results grid (`Hematology`, `Lipids`). */
interface Type {
  readonly name: string
  /** The section's comment lines printed before any row. */
  readonly comments: readonly string[]
  readonly groups: readonly Group.Type[]
}

export type { Type }
