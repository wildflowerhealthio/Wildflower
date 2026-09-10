import * as fc from 'fast-check'

import type {
  LifeLabsReport,
  ReportGroup,
  ReportLab,
  ReportPatient,
  ReportRow,
  ReportSection,
} from './report.ts'

/**
 * fast-check arbitraries for {@link LifeLabsReport}s that a printed layout
 * can carry faithfully — the reports `layoutReport` ∘ `parseReports` is the
 * identity on. Test-only, shared by the dialect and the FHIR tests.
 *
 * @remarks
 * The constraints are the print's, not the model's: a value is a trimmed,
 * non-blank run of printable text (a blank run is not printed at all), a
 * lab address prints at most three lines, only a section's leading group
 * may be unnamed, consecutive sections differ (a repeated heading is a page
 * break), and a lab licence, once printed, never reverts to none (the print
 * has no marker for that).
 *
 * @packageDocumentation
 */

/** Printable text the header parser never mistakes for a label. */
const text = (maxLength = 24): fc.Arbitrary<string> =>
  fc
    .stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .,\-/()<>=%#+*]{0,30}$/)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s.length > 0 && s.length <= maxLength && !s.endsWith(':'))

/** A value that may be absent (`''`) — the print's blank field. */
const optionalText = (maxLength = 24): fc.Arbitrary<string> =>
  fc.oneof({ arbitrary: text(maxLength), weight: 3 }, { arbitrary: fc.constant(''), weight: 1 })

const flag = fc.constantFrom('', '', 'HI', 'LO')

const numberText = fc
  .double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true })
  .map((n) => n.toFixed(fc.sample(fc.integer({ min: 0, max: 3 }), 1)[0] ?? 1))

const result = fc.oneof(
  numberText,
  numberText.map((n) => `<${n}`),
  fc.constantFrom('NEGATIVE', 'NOT DETECTED', 'YELLOW', 'CLEAR', '08:11', '04-SEP-2024', '')
)

const referenceRange = fc.oneof(
  fc.tuple(numberText, numberText).map(([low, high]) => `${low} - ${high}`),
  numberText.map((n) => `<${n}`),
  numberText.map((n) => `>=${n}`),
  fc.constantFrom('See below', 'NEGATIVE', '')
)

const unit = fc.constantFrom('', 'x E9/L', 'mmol/L', 'umol/L', 'g/L', '%', 'U/L', 'pmol/L', 'hours')

const row = (labLicence: fc.Arbitrary<string>): fc.Arbitrary<ReportRow> =>
  fc.record({
    name: text(40),
    flag,
    result,
    referenceRange,
    unit,
    labLicence,
    comments: fc.array(text(48), { maxLength: 3 }),
  })

/**
 * A licence sequence for one report: none throughout, or a printed licence
 * that may switch between two labs but never back to none.
 */
const licences: fc.Arbitrary<fc.Arbitrary<string>> = fc.constantFrom(
  fc.constant(''),
  fc.constant('#5687'),
  fc.constantFrom('#5687', '#5407')
)

const group = (licence: fc.Arbitrary<string>, unnamed: boolean): fc.Arbitrary<ReportGroup> =>
  fc.record({
    name: unnamed ? fc.constant('') : text(30),
    rows: fc.array(row(licence), { minLength: unnamed ? 1 : 0, maxLength: 4 }),
  })

const section = (licence: fc.Arbitrary<string>): fc.Arbitrary<ReportSection> =>
  fc
    .record({
      name: text(30),
      comments: fc.array(text(48), { maxLength: 2 }),
      leading: fc.option(group(licence, true), { nil: undefined }),
      named: fc.array(group(licence, false), { maxLength: 2 }),
    })
    .map(({ name, comments, leading, named }) => ({
      name,
      comments,
      groups: leading === undefined ? named : [leading, ...named],
    }))

const patient: fc.Arbitrary<ReportPatient> = fc.record({
  name: fc.oneof(
    fc.tuple(text(12), text(12)).map(([family, given]) => `${family.toUpperCase()}, ${given}`),
    fc.constant('')
  ),
  age: optionalText(12),
  sex: fc.constantFrom('F', 'M', ''),
  dateOfBirth: fc.constantFrom('Aug 13 1981', 'Feb 29 1996', 'Xxx 00 0000', ''),
  healthCardNumber: fc.constantFrom('1234567890 AB', '0000000000 XX', ''),
  phone: fc.constantFrom('(416) 555-0100', ''),
  patientId: optionalText(14),
})

const lab: fc.Arbitrary<ReportLab> = fc.record({
  addressLines: fc.array(text(24), { maxLength: 3 }),
  telephone: optionalText(16),
  tollFree: optionalText(16),
  fax: optionalText(16),
})

const printedDateTime = fc.constantFrom(
  'Aug 13 2026 13:02',
  'Jan 19 2024 08:53',
  'Nov 07 2022 12:23',
  'Xxx 00 0000 00:00',
  ''
)

/** Consecutive sections must differ — a repeated heading reads as a page break. */
const noConsecutiveDuplicates = (sections: readonly ReportSection[]): boolean =>
  sections.every((s, index) => index === 0 || sections[index - 1]?.name !== s.name)

/** A report a printed layout carries faithfully. */
const report: fc.Arbitrary<LifeLabsReport> = licences.chain((licence) =>
  fc.record({
    labNo: text(14),
    referenceNumber: optionalText(14),
    referringSiteId: optionalText(14),
    patient,
    orderedBy: optionalText(24),
    copyTo: fc.array(text(24), { maxLength: 1 }),
    dateOfService: printedDateTime,
    reportedOn: printedDateTime,
    lab,
    status: fc.constantFrom('FINAL RESULTS', ''),
    pageNumbers: fc.constant([]),
    sections: fc.array(section(licence), { maxLength: 4 }).filter(noConsecutiveDuplicates),
  })
)

export { report as reportArbitrary }
