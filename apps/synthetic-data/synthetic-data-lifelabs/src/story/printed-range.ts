import type { AdministrativeGender } from '@wildflowerhealthio/fhir-r4/data-types'
import { Match } from 'effect'

/**
 * A reference range as a LifeLabs report prints it in its `Reference Range`
 * column: `low - high`, `<high` or `>=low`.
 *
 * @remarks
 * Bounds are printed text, so a range prints `4.00`, not `4`; the `HI`/`LO`
 * flag is read off the same text ({@link flagOf}), so a flag always agrees
 * with the range beside it.
 */
type PrintedRange =
  | { readonly _tag: 'between'; readonly low: string; readonly high: string }
  | { readonly _tag: 'below'; readonly high: string }
  | { readonly _tag: 'atLeast'; readonly low: string }

/** `low - high`. */
const between = (low: string, high: string): PrintedRange => ({ _tag: 'between', low, high })
/** `<high`. */
const below = (high: string): PrintedRange => ({ _tag: 'below', high })
/** `>=low`. */
const atLeast = (low: string): PrintedRange => ({ _tag: 'atLeast', low })

/** The same range whatever the person's gender. */
const eitherSex = (range: PrintedRange): Readonly<Record<AdministrativeGender, PrintedRange>> => ({
  male: range,
  female: range,
  other: range,
  unknown: range,
})

/** The range as the `Reference Range` column prints it (`0.32 - 4.00`, `<3.50`, `>=60`). */
const print = (range: PrintedRange): string =>
  Match.valueTags(range, {
    between: ({ low, high }) => `${low} - ${high}`,
    below: ({ high }) => `<${high}`,
    atLeast: ({ low }) => `>=${low}`,
  })

/**
 * The `Flag` column for a result against its range: `HI` above it, `LO` below
 * it, `''` inside it.
 *
 * @remarks
 * A one-sided target flags only on the side it bounds: `<3.50` flags `HI` from
 * `3.50` up, `>=60` flags `LO` below `60`.
 */
const flagOf = (value: number, range: PrintedRange): 'HI' | 'LO' | '' =>
  Match.valueTags(range, {
    between: ({ low, high }): 'HI' | 'LO' | '' => {
      if (value < Number(low)) return 'LO'
      return value > Number(high) ? 'HI' : ''
    },
    below: ({ high }) => (value >= Number(high) ? 'HI' : ''),
    atLeast: ({ low }) => (value < Number(low) ? 'LO' : ''),
  })

export { atLeast, below, between, eitherSex, flagOf, print }
export type { PrintedRange }
