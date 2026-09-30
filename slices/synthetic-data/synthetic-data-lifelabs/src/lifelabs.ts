import { Data, DateTime, Effect, type ParseResult } from 'effect'
import type { ReferenceType } from 'fhir-r4/data-types'
import { type FhirResource, withSubject } from 'fhir-r4/resources'
import {
  adoptedResourcesOf,
  type LifeLabsReport,
  type ReportPatient,
  type ReportRow,
  type ReportSection,
} from 'lifelabs-pdf-importer-core/synthesis'
import * as Seeding from 'synthetic-data-fundamentals/seeding'
import { type LabDraw, Person, type Story, StoryDay } from 'synthetic-data-fundamentals/story'

import { type LabRequisition, Laboratory, PrintedRange } from './story/index.ts'

/**
 * The LifeLabs generator: a story's lab draws as the FHIR resources the LifeLabs
 * PDF import makes of them, filed on the person's pharmacy Patient.
 *
 * @remarks
 * Each day's draws are one report ({@link reportsOf}) — a `Report` as
 * `lifelabs-pdf-importer-core` reads one off a printed PDF: a `Lab No`, the
 * date of service and report, the patient block, the requisition's clinicians,
 * the laboratory's block, and the results grid with each test's printed name,
 * result, `HI`/`LO` flag, reference range, unit, lab licence and comments, as
 * the {@link Laboratory.Laboratory} prints them. Nothing here names a person or
 * a value: the story, laboratory and requisition carry them.
 * {@link render} runs those reports through the importer's own synthesis and
 * adoption (`adoptedResourcesOf`, what its decode yields), then:
 *
 * - drops the `Patient` the report's patient block makes — the person already
 *   has one, from their pharmacy — and points every `Observation` and
 *   `DiagnosticReport` `subject` at that pharmacy Patient instead;
 * - keeps the `Practitioner`s the requisition names.
 *
 * Nothing is PDF-shaped: the synthesis writes no source-file
 * `DocumentReference` and no `meta.source`, and none is added.
 *
 * Specimens are collected in the morning (fasting) and reported the same
 * evening, at minutes hashed from the person and day; the report's printed
 * clock is in the laboratory's zone.
 */

const FINAL_RESULTS = 'FINAL RESULTS'

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/** Minutes into the day a specimen may be collected: 07:15 to 10:45, fasting. */
const EARLIEST_COLLECTION_MINUTE = 7 * 60 + 15
const LATEST_COLLECTION_MINUTE = 10 * 60 + 45

/** Minutes from collection to the report: five to ten hours, the same evening. */
const EARLIEST_REPORT_AFTER_MINUTES = 5 * 60
const LATEST_REPORT_AFTER_MINUTES = 10 * 60

/** A story draws a test the laboratory prints no row for. */
class UncataloguedLabTest extends Data.TaggedError('UncataloguedLabTest')<{
  readonly test: string
}> {
  override get message(): string {
    return `the laboratory prints no test for the story's "${this.test}"`
  }
}

/** A calendar date as the report prints it (`Aug 3 2026`). */
const printedDateOf = (date: DateTime.Utc): string => {
  const { year, month, day } = DateTime.toPartsUtc(date)
  return `${MONTHS[month - 1] ?? ''} ${day} ${year}`
}

/** A story day and a local clock time as the report prints them (`Aug 3 2026 08:41`). */
const printedDateTimeOf = (asOf: DateTime.Utc, day: StoryDay.StoryDay, minute: number): string => {
  const clock = [Math.floor(minute / 60), minute % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
  return `${printedDateOf(StoryDay.toDateTime(asOf, day))} ${clock}`
}

/** The report's `Sex:` field: `M` or `F`, blank for a gender it does not print. */
const SEX_PRINTED: Readonly<Record<Person.Person['gender'], string>> = {
  male: 'M',
  female: 'F',
  other: '',
  unknown: '',
}

/** Whole years from `birthDate` to `date`. */
const yearsBetween = (birthDate: DateTime.Utc, date: DateTime.Utc): number => {
  const born = DateTime.toPartsUtc(birthDate)
  const on = DateTime.toPartsUtc(date)
  const beforeBirthday = on.month < born.month || (on.month === born.month && on.day < born.day)
  return on.year - born.year - (beforeBirthday ? 1 : 0)
}

/** The patient block on the report of the draws on `day`. */
const patientBlockOf = (
  asOf: DateTime.Utc,
  person: Person.Person,
  day: StoryDay.StoryDay
): ReportPatient => {
  const birthDate = Person.birthDateOf(person, asOf)
  return {
    name: `${person.familyName.toUpperCase()}, ${person.givenName.toUpperCase()}`,
    age: `${yearsBetween(birthDate, StoryDay.toDateTime(asOf, day))} years`,
    sex: SEX_PRINTED[person.gender],
    dateOfBirth: printedDateOf(birthDate),
    healthCardNumber: '',
    phone: '',
    patientId: '',
  }
}

/** A story's unit as the report prints it: ASCII `u` for micro, `''` for none. */
const printedUnitOf = (unit: string | null): string =>
  unit === null ? '' : unit.replaceAll('µ', 'u')

/** The `Lab No` of the draws on `day`: the year of service, two letters and seven digits. */
const labNumberOf = (asOf: DateTime.Utc, person: Person.Person, day: StoryDay.StoryDay): string => {
  const keys = [person.key, 'lifelabs', 'lab-no', String(day)]
  const letters = Seeding.integerOf([...keys, 'letters'], 0, 26 * 26 - 1)
  const prefix = String.fromCodePoint(65 + Math.floor(letters / 26), 65 + (letters % 26))
  const { year } = DateTime.toPartsUtc(StoryDay.toDateTime(asOf, day))
  return `${year}-${prefix}${Seeding.digitsOf(keys, 7)}`
}

/**
 * One draw as its row of the results grid. The flag is read off the printed
 * result, not the story's value, so a value that rounds onto a bound flags as
 * the result beside it reads.
 */
const rowOf = (
  laboratory: Laboratory.Laboratory,
  person: Person.Person,
  test: Laboratory.LifeLabsTest,
  draw: LabDraw.LabDraw
): ReportRow => {
  const range = test.range[person.gender]
  const result = draw.value.toFixed(test.decimals)
  return {
    name: test.name,
    flag: PrintedRange.flagOf(Number(result), range),
    result,
    referenceRange: PrintedRange.print(range),
    unit: printedUnitOf(draw.unit),
    labLicence: laboratory.licence,
    comments: test.comments,
  }
}

/**
 * One day's draws as the report's sections: rows in the laboratory's order,
 * under the section and group heading each test prints under.
 */
const sectionsOf = (
  laboratory: Laboratory.Laboratory,
  person: Person.Person,
  draws: readonly LabDraw.LabDraw[]
): Effect.Effect<readonly ReportSection[], UncataloguedLabTest> =>
  Effect.gen(function* () {
    const printed: {
      readonly test: Laboratory.LifeLabsTest
      readonly printIndex: number
      readonly draw: LabDraw.LabDraw
    }[] = []
    for (const draw of draws) {
      const test = Laboratory.testOf(laboratory, draw.test)
      if (test === undefined) return yield* new UncataloguedLabTest({ test: draw.test })
      printed.push({ test, printIndex: laboratory.tests.indexOf(test), draw })
    }
    const inPrintOrder = printed.toSorted((left, right) => left.printIndex - right.printIndex)
    const sections: {
      name: string
      comments: []
      groups: { name: string; rows: ReportRow[] }[]
    }[] = []
    for (const { test, draw } of inPrintOrder) {
      let section = sections.at(-1)
      if (section?.name !== test.section) {
        section = { name: test.section, comments: [], groups: [] }
        sections.push(section)
      }
      let group = section.groups.at(-1)
      if (group?.name !== test.group) {
        group = { name: test.group, rows: [] }
        section.groups.push(group)
      }
      group.rows.push(rowOf(laboratory, person, test, draw))
    }
    return sections
  })

/**
 * The story's lab draws as LifeLabs reports, one per day drawn, in day order.
 *
 * @param asOf - The as-of instant every story day is dated from; only its UTC
 *   calendar day matters
 * @param story - Whose draws are reported
 * @param laboratory - The lab the specimens go to, and how it prints each test
 * @param requisition - The clinicians the reports name
 * @returns The reports; fails with {@link UncataloguedLabTest} when a draw names
 *   a test the laboratory does not print
 */
const reportsOf = (
  asOf: DateTime.Utc,
  story: Story.Story,
  laboratory: Laboratory.Laboratory,
  requisition: LabRequisition.LabRequisition
): Effect.Effect<readonly LifeLabsReport[], UncataloguedLabTest> =>
  Effect.forEach(
    [...new Set(story.labDraws.map((draw) => draw.day))].toSorted((left, right) => left - right),
    (day) =>
      Effect.map(
        sectionsOf(
          laboratory,
          story.person,
          story.labDraws.filter((draw) => draw.day === day)
        ),
        (sections): LifeLabsReport => {
          const keys = [story.person.key, 'lifelabs', String(day)]
          const collectedMinute = Seeding.integerOf(
            [...keys, 'collected'],
            EARLIEST_COLLECTION_MINUTE,
            LATEST_COLLECTION_MINUTE
          )
          const reportedMinute =
            collectedMinute +
            Seeding.integerOf(
              [...keys, 'reported'],
              EARLIEST_REPORT_AFTER_MINUTES,
              LATEST_REPORT_AFTER_MINUTES
            )
          return {
            labNo: labNumberOf(asOf, story.person, day),
            referenceNumber: '',
            referringSiteId: '',
            patient: patientBlockOf(asOf, story.person, day),
            orderedBy: requisition.orderedBy,
            copyTo: requisition.copyTo,
            dateOfService: printedDateTimeOf(asOf, day, collectedMinute),
            reportedOn: printedDateTimeOf(asOf, day, reportedMinute),
            lab: { addressLines: laboratory.addressLines, telephone: '', tollFree: '', fax: '' },
            status: FINAL_RESULTS,
            pageNumbers: [1],
            sections,
          }
        }
      )
  )

/**
 * The story's lab results as the LifeLabs import makes them, on the person's
 * pharmacy Patient.
 *
 * @param asOf - The as-of instant every story day is dated from; only its UTC
 *   calendar day matters
 * @param story - Whose draws are reported
 * @param laboratory - The lab the specimens go to, and how it prints each test
 * @param requisition - The clinicians the reports name
 * @param pharmacyPatient - A reference to the Patient the person's pharmacy
 *   import makes (`rexallPatientReferenceOf`, `shoppersPatientReferenceOf`),
 *   which every result's `subject` is
 * @returns The adopted resources in the order a writer persists them — each
 *   report's newly named `Practitioner`s, then its `Observation`s and its
 *   `DiagnosticReport` — with no `Patient`; the same for the same inputs.
 *   Fails with {@link UncataloguedLabTest} when a draw names a test the
 *   laboratory does not print, or a `ParseError` when the synthesis does not
 *   satisfy its `fhir-r4` schema
 */
const render = (
  asOf: DateTime.Utc,
  story: Story.Story,
  laboratory: Laboratory.Laboratory,
  requisition: LabRequisition.LabRequisition,
  pharmacyPatient: ReferenceType
): Effect.Effect<readonly FhirResource[], UncataloguedLabTest | ParseResult.ParseError> =>
  Effect.gen(function* () {
    const reports = yield* reportsOf(asOf, story, laboratory, requisition)
    const groups = yield* adoptedResourcesOf(reports, { timeZone: laboratory.timeZone })
    return groups
      .flatMap((group) => group.resources)
      .filter((resource) => resource.resourceType !== 'Patient')
      .map(withSubject(pharmacyPatient))
  })

export { render, reportsOf, UncataloguedLabTest }
