/**
 * fast-check arbitraries for the LifeLabs generator's inputs beyond the
 * person (which `synthetic-data-fundamentals/test-helpers` draws): a
 * laboratory and how it prints each test, lab draws on it, and a requisition,
 * shared through the `synthetic-data-lifelabs/test-helpers` subpath.
 *
 * @packageDocumentation
 */
import * as fc from 'fast-check'
import type { LabDraw, Story } from 'synthetic-data-fundamentals/story'
import { personArbitrary } from 'synthetic-data-fundamentals/test-helpers'

import { type LabRequisition, type Laboratory, PrintedRange } from './story/index.ts'

/*
 * Drawn from the LifeLabs print's alphabet so that a report laid out and read
 * back by the importer is the same report. A printable `Laboratory` keeps the
 * print's constraints: section names are distinct, and within a section only
 * the first group may be unnamed and group names are distinct.
 */

const ANALYTES = [
  'Sodium',
  'Potassium',
  'Chloride',
  'Glucose Random',
  'ALT',
  'Albumin',
  'Calcium',
  'Urea',
  'Iron',
  'Vitamin B12',
  'CRP',
  'Free T3',
  'PSA',
  'CK',
  'Magnesium',
  'Phosphate',
] as const
const LAB_SECTIONS = ['Hematology', 'Chemistry', 'Immunology', 'Endocrinology'] as const
const LAB_GROUPS = ['Differential', 'Electrolytes', 'Liver Function', 'Thyroid'] as const
const LAB_COMMENTS = ['Fasting specimen.', 'Repeat in 3 months.', 'Verified by repeat analysis.']
const LAB_UNITS = [null, 'mmol/L', 'µmol/L', 'g/L', 'µg/L', 'x E9/L', '%', 'mIU/L', 'U/L', 'hours']
const ORDERING_PRACTITIONERS = [
  'ROY DR. ANNE',
  'NGUYEN DR. LEE',
  'LAVOIE DR. PAT',
  'OSEI DR. KWAME',
]
const LAB_ADDRESSES = [
  ['1 Example Blvd.', 'Toronto, Ontario', 'Canada M0M 0M0'],
  ['2 Sample Way', 'Kingston, Ontario'],
] as const

/** A non-negative number with `decimals` places, as its printed text. */
const printedNumberArbitrary = (decimals: number): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: 99_999 }).map((scaled) => (scaled / 10 ** decimals).toFixed(decimals))

const printedRangeArbitrary: fc.Arbitrary<PrintedRange.PrintedRange> = fc
  .integer({ min: 0, max: 3 })
  .chain((decimals) =>
    fc.oneof(
      fc
        .tuple(printedNumberArbitrary(decimals), printedNumberArbitrary(decimals))
        .map(([one, other]): PrintedRange.PrintedRange => {
          const [low = one, high = other] = [one, other].toSorted(
            (left, right) => Number(left) - Number(right)
          )
          return PrintedRange.between(low, high)
        }),
      printedNumberArbitrary(decimals).map(PrintedRange.below),
      printedNumberArbitrary(decimals).map(PrintedRange.atLeast)
    )
  )

/** One section's groups: an optional unnamed leading group, then distinct named ones. */
const groupNamesArbitrary: fc.Arbitrary<readonly string[]> = fc
  .tuple(fc.boolean(), fc.uniqueArray(fc.constantFrom(...LAB_GROUPS), { maxLength: 2 }))
  .map(([leadingUnnamed, named]) => (leadingUnnamed || named.length === 0 ? ['', ...named] : named))

/**
 * A laboratory printing up to about a dozen tests, each with its own story
 * name (`analyte-<n>`), under distinct sections.
 */
const laboratoryArbitrary: fc.Arbitrary<Laboratory.Laboratory> = fc
  .record({
    addressLines: fc.constantFrom(...LAB_ADDRESSES),
    licence: fc.constantFrom('#5687', '#5407'),
    timeZone: fc.constantFrom('America/Toronto', 'America/Vancouver'),
    headings: fc
      .uniqueArray(fc.constantFrom(...LAB_SECTIONS), { minLength: 1, maxLength: 3 })
      .chain((sections) =>
        fc.tuple(
          ...sections.map((section) =>
            groupNamesArbitrary.map((groups) => groups.map((group) => ({ section, group })))
          )
        )
      )
      .map((perSection) => perSection.flat()),
  })
  .chain(({ addressLines, licence, timeZone, headings }) =>
    fc
      .tuple(
        ...headings.map((heading) =>
          fc
            .array(
              fc.record({
                name: fc.constantFrom(...ANALYTES),
                decimals: fc.integer({ min: 0, max: 3 }),
                male: printedRangeArbitrary,
                female: printedRangeArbitrary,
                other: printedRangeArbitrary,
                unknown: printedRangeArbitrary,
                comments: fc.subarray(LAB_COMMENTS, { maxLength: 2 }),
              }),
              { minLength: 1, maxLength: 3 }
            )
            .map((tests) => tests.map((test) => ({ ...heading, ...test })))
        )
      )
      .map((perHeading): Laboratory.Laboratory => ({
        addressLines,
        licence,
        timeZone,
        tests: perHeading.flat().map((test, index): Laboratory.LifeLabsTest => ({
          storyTest: `analyte-${index}`,
          name: test.name,
          section: test.section,
          group: test.group,
          decimals: test.decimals,
          range: { male: test.male, female: test.female, other: test.other, unknown: test.unknown },
          comments: test.comments,
        })),
      }))
  )

/**
 * Draws on one to five distinct days before the as-of day, each on a distinct
 * subset of the laboratory's tests, every value printable at its test's
 * decimals.
 */
const labDrawsArbitrary = (
  laboratory: Laboratory.Laboratory
): fc.Arbitrary<readonly LabDraw.LabDraw[]> =>
  fc
    .uniqueArray(fc.integer({ min: -1000, max: -1 }), { minLength: 1, maxLength: 5 })
    .chain((days) =>
      fc.tuple(
        ...days
          .toSorted((left, right) => left - right)
          .map((day) =>
            fc.subarray([...laboratory.tests], { minLength: 1 }).chain((tests) =>
              fc.tuple(
                ...tests.map((test) =>
                  fc
                    .record({
                      value: printedNumberArbitrary(test.decimals).map(Number),
                      unit: fc.constantFrom(...LAB_UNITS),
                    })
                    .map(({ value, unit }): LabDraw.LabDraw => ({
                      day,
                      test: test.storyTest,
                      value,
                      unit,
                    }))
                )
              )
            )
          )
      )
    )
    .map((perDay) => perDay.flat())

/** A laboratory, and a person's story of lab draws it prints (no prescriptions). */
const labStoryArbitrary: fc.Arbitrary<{
  readonly laboratory: Laboratory.Laboratory
  readonly story: Story.Story
}> = laboratoryArbitrary.chain((laboratory) =>
  fc
    .record({ person: personArbitrary('person-1'), labDraws: labDrawsArbitrary(laboratory) })
    .map(({ person, labDraws }) => ({ laboratory, story: { person, prescriptions: [], labDraws } }))
)

/** Ordered by one practitioner, copied to at most one other (the print joins a longer list). */
const requisitionArbitrary: fc.Arbitrary<LabRequisition.LabRequisition> = fc.record({
  orderedBy: fc.constantFrom(...ORDERING_PRACTITIONERS),
  copyTo: fc
    .option(fc.constantFrom(...ORDERING_PRACTITIONERS), { nil: undefined })
    .map((copied): LabRequisition.LabRequisition['copyTo'] =>
      copied === undefined ? [] : [copied]
    ),
})

export { labDrawsArbitrary, laboratoryArbitrary, labStoryArbitrary, requisitionArbitrary }
