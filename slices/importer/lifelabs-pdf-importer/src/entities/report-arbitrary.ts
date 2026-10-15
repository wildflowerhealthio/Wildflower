import * as fc from 'fast-check'

import { optionalText, text } from '../document/printed-text.ts'
import { arbitrary as labArbitrary } from './lab-arbitrary.ts'
import { arbitrary as patientArbitrary } from './patient-arbitrary.ts'
import type * as Report from './report.ts'
import { arbitrary as sectionArbitrary } from './section-arbitrary.ts'
import type * as Section from './section.ts'

/**
 * The fast-check arbitrary for a {@link Report.Type} — the reports a printed
 * layout can carry faithfully, i.e. the reports `layoutReport` ∘
 * `Report.tryFromDocument` is the identity on. Test-only, and the composition
 * root: it draws its patient, lab and sections from their sibling arbitraries.
 *
 * @remarks
 * The constraints are the print's, not the model's: only a section's leading
 * group may be unnamed, consecutive sections differ (a repeated heading is a
 * page break), and a lab licence, once printed, never reverts to none (the
 * print has no marker for that).
 *
 * @packageDocumentation
 */

const printedDateTime = fc.constantFrom(
  'Aug 13 2026 13:02',
  'Jan 19 2024 08:53',
  'Nov 07 2022 12:23',
  'Xxx 00 0000 00:00',
  ''
)

/** How one report's rows print their lab licence. */
interface LicencePlan {
  /** The licence each row draws. */
  readonly licence: fc.Arbitrary<string>
  /** How many of the report's first rows, in print order, print no licence. */
  readonly unlicensedLeadingRows: fc.Arbitrary<number>
}

/**
 * A licence sequence for one report: none throughout; a printed licence that
 * may switch between two labs but never back to none; or rows with no
 * licence, then a licence from there on.
 */
const licencePlans: fc.Arbitrary<LicencePlan> = fc.constantFrom(
  { licence: fc.constant(''), unlicensedLeadingRows: fc.constant(0) },
  { licence: fc.constant('#5687'), unlicensedLeadingRows: fc.constant(0) },
  { licence: fc.constantFrom('#5687', '#5407'), unlicensedLeadingRows: fc.constant(0) },
  { licence: fc.constant('#5687'), unlicensedLeadingRows: fc.integer({ min: 1, max: 8 }) }
)

/** The sections with the licence cleared off their first `count` rows, in print order. */
const withUnlicensedLeadingRows = (
  sections: readonly Section.Type[],
  count: number
): readonly Section.Type[] => {
  let remaining = count
  return sections.map((section) => ({
    ...section,
    groups: section.groups.map((group) => ({
      ...group,
      rows: group.rows.map((row) => {
        if (remaining === 0) return row
        remaining -= 1
        return { ...row, labLicence: '' }
      }),
    })),
  }))
}

/** Consecutive sections must differ — a repeated heading reads as a page break. */
const noConsecutiveDuplicates = (sections: readonly Section.Type[]): boolean =>
  sections.every((s, index) => index === 0 || sections[index - 1]?.name !== s.name)

const arbitrary: fc.Arbitrary<Report.Type> = licencePlans.chain(
  ({ licence, unlicensedLeadingRows }) =>
    fc
      .tuple(
        fc.record({
          labNo: text(14),
          referenceNumber: optionalText(14),
          referringSiteId: optionalText(14),
          patient: patientArbitrary,
          orderedBy: optionalText(24),
          copyTo: fc.array(text(24), { maxLength: 1 }),
          dateOfService: printedDateTime,
          reportedOn: printedDateTime,
          lab: labArbitrary,
          status: fc.constantFrom('FINAL RESULTS', ''),
          pageNumbers: fc.constant([]),
          sections: fc
            .array(sectionArbitrary(licence), { maxLength: 4 })
            .filter(noConsecutiveDuplicates),
        }),
        unlicensedLeadingRows
      )
      .map(([report, count]) => ({
        ...report,
        sections: withUnlicensedLeadingRows(report.sections, count),
      }))
)

export { arbitrary }
