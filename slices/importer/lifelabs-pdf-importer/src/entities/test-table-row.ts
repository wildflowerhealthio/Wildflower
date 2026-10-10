/**
 * One test row of the results grid, with the comment lines printed under it —
 * the report's own text, nothing interpreted (a `<0.1` result is the string
 * `<0.1`).
 *
 * @remarks
 * The fast-check `arbitrary` that lays a row out for tests lives in the sibling
 * `test-table-row-arbitrary.ts` (test-only).
 *
 * @packageDocumentation
 */

/** One test row of the results grid, with the comment lines printed under it. */
interface Type {
  /** The `Test` column — the test's name as printed. */
  readonly name: string
  /** The `Flag` column (`HI`, `LO`), or `''`. */
  readonly flag: string
  /** The `Result` column as printed (`8.0`, `<0.1`, `NEGATIVE`), or `''`. */
  readonly result: string
  /** The reference range as printed (`4.0 - 11.0`, `<36`, `See below`), or `''`. */
  readonly referenceRange: string
  /** The unit as printed (`x E9/L`, `%`), or `''`. */
  readonly unit: string
  /** The `Lab Lic. #` in force for this row (`#5687`), or `''`. */
  readonly labLicence: string
  /** The comment lines printed under the row, one entry per printed line. */
  readonly comments: readonly string[]
}

export type { Type }
