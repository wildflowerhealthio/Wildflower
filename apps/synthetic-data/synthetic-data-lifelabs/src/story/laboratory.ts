import type { AdministrativeGender } from '@wildflowerhealthio/fhir-r4/data-types'

import type { PrintedRange } from './printed-range.ts'

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
  /** The range printed for a person of each administrative gender. */
  readonly range: Readonly<Record<AdministrativeGender, PrintedRange>>
  /** Lines printed under the row. */
  readonly comments: readonly string[]
}

/**
 * A LifeLabs laboratory as its reports print it: the lab block's address, the
 * licence beside every row, the zone its printed clock is in, and how it
 * prints each test it runs — the printed name, the section and group heading,
 * the decimals its result prints with, the reference range (by sex) and the
 * comment lines under it.
 *
 * @remarks
 * A story's draws name tests by `LabDraw.test`; a {@link LifeLabsTest}'s
 * `storyTest` is the name it prints for.
 */
interface Laboratory {
  /** The lab block's `Address:` lines, one per printed line. */
  readonly addressLines: readonly string[]
  /** The `Lab Lic. #` printed beside every row (`#5687`). */
  readonly licence: string
  /**
   * The IANA zone the lab's printed clock is in: LifeLabs runs labs in Ontario
   * (`America/Toronto`) and British Columbia (`America/Vancouver`).
   */
  readonly timeZone: string
  /**
   * Every test the lab prints, in the order a report prints them; the tests
   * sharing a section and group heading sit together.
   */
  readonly tests: readonly LifeLabsTest[]
}

/** The test `laboratory` prints a story's `storyTest` as, if it runs one. */
const testOf = (laboratory: Laboratory, storyTest: string): LifeLabsTest | undefined =>
  laboratory.tests.find((test) => test.storyTest === storyTest)

export { testOf }
export type { Laboratory, LifeLabsTest }
