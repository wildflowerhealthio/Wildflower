/**
 * A titled group of rows, reviewed under its title: one section of a
 * `SectionedList`.
 *
 * @packageDocumentation
 */

/** A titled group of rows, reviewed under its title. */
interface Type<E> {
  readonly title: string
  readonly rows: readonly E[]
}

/** `rows` under `title`. */
const make = <E>(title: string, rows: readonly E[]): Type<E> => ({ title, rows })

export { make }
export type { Type }
