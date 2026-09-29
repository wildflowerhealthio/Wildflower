import { Match } from 'effect'

import type { Gender } from '../person.ts'

/**
 * A LifeLabs laboratory as its reports print it: the lab block's address, the
 * licence beside every row, and how it prints each test it runs — the printed
 * name, the section and group heading, the decimals its result prints with,
 * the reference range (by sex) and the comment lines under it.
 *
 * @remarks
 * A story's draws name tests by `LabDraw.test`; a {@link LifeLabsTest}'s
 * `storyTest` is the name it prints for. Bounds are printed text, so a range
 * prints `4.00`, not `4`; the `HI`/`LO` flag is read off the same text
 * ({@link flagOf}), so a flag always agrees with the range beside it.
 */

/** A reference range as the report prints it: `low - high`, `<high` or `>=low`. */
type PrintedRange =
  | { readonly _tag: 'between'; readonly low: string; readonly high: string }
  | { readonly _tag: 'below'; readonly high: string }
  | { readonly _tag: 'atLeast'; readonly low: string }

/** One test as a LifeLabs report prints it. */
interface LifeLabsTest {
  /** The `LabDraw.test` it prints. */
  readonly storyTest: string
  /** The `Test` column. */
  readonly name: string
  /** The section heading it prints under (`Hematology`, `Chemistry`). */
  readonly section: string
  /** The group heading inside the section, or `''` for the section's leading rows. */
  readonly group: string
  /** Decimal places the `Result` column prints. */
  readonly decimals: number
  readonly range: Readonly<Record<Gender, PrintedRange>>
  /** Lines printed under the row. */
  readonly comments: readonly string[]
}

/** See the module summary. */
interface Laboratory {
  /** The lab block's `Address:` lines, one per printed line. */
  readonly addressLines: readonly string[]
  /** The `Lab Lic. #` printed beside every row (`#5687`). */
  readonly licence: string
  /**
   * Every test the lab prints, in the order a report prints them; the tests
   * sharing a section and group heading sit together.
   */
  readonly tests: readonly LifeLabsTest[]
}

const between = (low: string, high: string): PrintedRange => ({ _tag: 'between', low, high })
const below = (high: string): PrintedRange => ({ _tag: 'below', high })
const atLeast = (low: string): PrintedRange => ({ _tag: 'atLeast', low })

/** The same range for either sex. */
const eitherSex = (range: PrintedRange): Readonly<Record<Gender, PrintedRange>> => ({
  male: range,
  female: range,
})

/** The range as the `Reference Range` column prints it (`0.32 - 4.00`, `<3.50`, `>=60`). */
const printRange = (range: PrintedRange): string =>
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

/** The test `laboratory` prints a story's `storyTest` as, if it runs one. */
const testOf = (laboratory: Laboratory, storyTest: string): LifeLabsTest | undefined =>
  laboratory.tests.find((test) => test.storyTest === storyTest)

export { atLeast, below, between, eitherSex, flagOf, printRange, testOf }
export type { Laboratory, LifeLabsTest, PrintedRange }
