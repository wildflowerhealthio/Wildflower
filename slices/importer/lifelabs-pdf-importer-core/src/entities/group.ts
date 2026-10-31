import type * as TestTableRow from './test-table-row.ts'

/**
 * A named sub-group of rows inside a section (`Differential`, `Lithium`).
 *
 * @remarks
 * The fast-check `arbitrary` that lays a group out for tests lives in the
 * sibling `group-arbitrary.ts` (test-only).
 *
 * @packageDocumentation
 */

/** A named sub-group of rows inside a section (`Differential`, `Lithium`). */
interface Type {
  /** The group heading, or `''` for a section's ungrouped leading rows. */
  readonly name: string
  readonly rows: readonly TestTableRow.Type[]
}

export type { Type }
