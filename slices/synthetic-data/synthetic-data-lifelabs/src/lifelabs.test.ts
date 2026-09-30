import { DateTime, Effect, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { Quantity } from 'fhir-r4/data-types'
import { adoptedReferenceOf } from 'fhir-r4/identity'
import {
  DiagnosticReport,
  type FhirResource,
  FhirResourceSchema,
  Observation,
  Practitioner,
} from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import {
  decodeLifeLabsPdfDocument,
  defaultLifeLabsPdfSettings,
  Report,
} from 'lifelabs-pdf-importer-core'
import { layoutDocument } from 'lifelabs-pdf-importer-core/test-helpers'
import { type Story, StoryDay } from 'synthetic-data-fundamentals/story'
import { asOfArbitrary } from 'synthetic-data-fundamentals/test-helpers'
import { describe, expect, test } from 'vite-plus/test'

import * as Laboratory from './laboratory.ts'
import * as LifeLabs from './lifelabs.ts'
import { labStoryArbitrary, requisitionArbitrary } from './test-helpers.ts'

/**
 * The LifeLabs renderer over generated laboratories and lab draws: what it
 * emits (only results and practitioners, valid under fhir-r4's schemas, every
 * subject the pharmacy Patient given), that each draw's value, unit, range and
 * flag come through, that it is deterministic and dated from the as-of day,
 * and that its reports are what the importer reads back off their print.
 */

const RUNS = numRunsFor({ base: 25 })

/** A Patient some other source's import adopted, keyed by a uuid. */
const pharmacyPatientArbitrary = fc
  .record({
    system: fc.constantFrom(
      'https://wildflowerhealth.io/fhir/sid/rexall-carebook',
      'https://wildflowerhealth.io/fhir/sid/shoppers-drugmart'
    ),
    originalId: fc.uuid(),
  })
  .map(({ system, originalId }) => adoptedReferenceOf({ system }, 'Patient', originalId))

const inputsArbitrary = fc.record({
  asOf: asOfArbitrary,
  storyWithLaboratory: labStoryArbitrary,
  requisition: requisitionArbitrary,
  pharmacyPatient: pharmacyPatientArbitrary,
})

type Inputs = typeof inputsArbitrary extends fc.Arbitrary<infer Generated> ? Generated : never

const renderOf = (inputs: Inputs): readonly FhirResource[] =>
  Effect.runSync(
    LifeLabs.render(
      inputs.asOf,
      inputs.storyWithLaboratory.story,
      inputs.storyWithLaboratory.laboratory,
      inputs.requisition,
      inputs.pharmacyPatient
    )
  )

const encodeResource = Schema.encodeSync(FhirResourceSchema)

/** The fhir-r4 schema of every resource type the renderer may emit. */
const SCHEMAS: Partial<Record<FhirResource['resourceType'], Schema.Schema.AnyNoContext>> = {
  Observation: Observation.Schema,
  DiagnosticReport: DiagnosticReport.Schema,
  Practitioner: Practitioner.Schema,
}

/** The interpretation code the importer maps a printed flag to. */
const INTERPRETATION_OF_FLAG = { HI: 'H', LO: 'L', '': null } as const

/** The resources as the JSON a writer would store. */
const toJson = (resources: readonly FhirResource[]): string =>
  JSON.stringify(resources.map((resource) => encodeResource(resource)))

const observationsIn = (resources: readonly FhirResource[]): readonly Observation.Type[] =>
  resources.flatMap((resource) => (resource.resourceType === 'Observation' ? [resource] : []))

const diagnosticReportsIn = (
  resources: readonly FhirResource[]
): readonly DiagnosticReport.Type[] =>
  resources.flatMap((resource) => (resource.resourceType === 'DiagnosticReport' ? [resource] : []))

/** An Observation's `valueQuantity`, decoded: the `value[x]` choice is typed `any`. */
const quantityOf = (observation: Observation.Type): typeof Quantity.Schema.Type | null =>
  Option.getOrNull(
    Schema.decodeUnknownOption(Schema.typeSchema(Quantity.Schema))(observation.valueQuantity)
  )

/**
 * Each report's draws in the order its rows print, reports in day order — the
 * order the DiagnosticReports list their results in.
 */
const drawsInPrintOrder = (
  laboratory: Laboratory.Laboratory,
  story: Story.Story
): readonly Story.Story['labDraws'][] =>
  [...new Set(story.labDraws.map((draw) => draw.day))]
    .toSorted((left, right) => left - right)
    .map((day) =>
      story.labDraws
        .filter((draw) => draw.day === day)
        .toSorted(
          (left, right) =>
            laboratory.tests.findIndex((labTest) => labTest.storyTest === left.test) -
            laboratory.tests.findIndex((labTest) => labTest.storyTest === right.test)
        )
    )

/** A fixed person's story with only `draw`, for the example tests. */
const storyDrawing = (draw: Story.Story['labDraws'][number]): Story.Story => ({
  person: {
    key: 'alex',
    givenName: 'Alex',
    familyName: 'Rivera',
    gender: 'female',
    age: 40,
    daysSinceBirthday: 0,
    email: 'alex@example.com',
    postalCode: 'K7L 2V4',
  },
  prescriptions: [],
  labDraws: [draw],
})

describe('LifeLabs.render', () => {
  test('property: emits only Practitioners, Observations and DiagnosticReports, each valid under its fhir-r4 schema', () => {
    fc.assert(
      fc.property(inputsArbitrary, (inputs) => {
        const resources = renderOf(inputs)
        for (const resource of resources) {
          const encoded = encodeResource(resource)
          expect(resource.meta).toBeNull()
          const schema = SCHEMAS[resource.resourceType]
          if (schema === undefined) expect.fail(`unexpected ${resource.resourceType}`)
          else Schema.decodeUnknownSync(schema)(encoded)
        }
        const { requisition } = inputs
        expect(
          resources.filter((resource) => resource.resourceType === 'Practitioner')
        ).toHaveLength(new Set([requisition.orderedBy, ...requisition.copyTo]).size)
      }),
      { numRuns: RUNS }
    )
  })

  test('property: files every result on the pharmacy Patient given', () => {
    fc.assert(
      fc.property(inputsArbitrary, (inputs) => {
        const resources = renderOf(inputs)
        const results = [...observationsIn(resources), ...diagnosticReportsIn(resources)]
        expect(results.length).toBeGreaterThan(0)
        for (const result of results) expect(result.subject).toEqual(inputs.pharmacyPatient)
      }),
      { numRuns: RUNS }
    )
  })

  test("property: one report per day drawn, listing one Observation per draw with the draw's value, unit, range and flag", () => {
    fc.assert(
      fc.property(inputsArbitrary, (inputs) => {
        const { laboratory, story } = inputs.storyWithLaboratory
        const resources = renderOf(inputs)
        const observationById = new Map(
          observationsIn(resources).map((observation) => [
            `Observation/${observation.id}`,
            observation,
          ])
        )
        const reports = diagnosticReportsIn(resources)
        const drawsByReport = drawsInPrintOrder(laboratory, story)
        expect(reports).toHaveLength(drawsByReport.length)
        expect(observationById.size).toBe(story.labDraws.length)
        reports.forEach((report, reportIndex) => {
          const draws = drawsByReport[reportIndex] ?? []
          expect(report.result).toHaveLength(draws.length)
          draws.forEach((draw, rowIndex) => {
            const observation = observationById.get(report.result[rowIndex]?.reference ?? '')
            const labTest = Laboratory.testOf(laboratory, draw.test)
            const range = labTest?.range[story.person.gender]
            if (observation === undefined || labTest === undefined || range === undefined) {
              expect.fail(`no Observation for ${draw.test} on day ${draw.day}`)
            }
            const quantity = quantityOf(observation)
            const [referenceRange] = observation.referenceRange
            const flag = Laboratory.flagOf(draw.value, range)
            expect({
              name: observation.code.text,
              category: observation.category[0]?.coding[0]?.code,
              value: quantity?.value,
              unit: quantity?.unit ?? null,
              low: referenceRange?.low?.value ?? null,
              high: referenceRange?.high?.value ?? null,
              rangeText: referenceRange?.text,
              interpretation: observation.interpretation[0]?.coding[0]?.code ?? null,
              comments: observation.note[0]?.text ?? null,
              effective: DateTime.formatIsoDate(
                DateTime.unsafeMake(observation.effectiveDateTime ?? 0)
              ),
            }).toEqual({
              name: labTest.name,
              category: 'laboratory',
              value: draw.value,
              unit: draw.unit === null ? null : draw.unit.replaceAll('µ', 'u'),
              low: range._tag === 'below' ? null : Number(range.low),
              high: range._tag === 'atLeast' ? null : Number(range.high),
              rangeText: Laboratory.printRange(range),
              interpretation: INTERPRETATION_OF_FLAG[flag],
              comments: labTest.comments.length === 0 ? null : labTest.comments.join('\n'),
              effective: StoryDay.toIsoDate(inputs.asOf, draw.day),
            })
          })
        })
      }),
      { numRuns: RUNS }
    )
  })

  test('property: is identical for any two instants on the same as-of day', () => {
    fc.assert(
      fc.property(inputsArbitrary, fc.integer({ min: 0, max: 86_399_999 }), (inputs, millis) => {
        const sameDay = DateTime.add(DateTime.startOf(inputs.asOf, 'day'), { millis })
        expect(toJson(renderOf({ ...inputs, asOf: sameDay }))).toBe(toJson(renderOf(inputs)))
      }),
      { numRuns: RUNS }
    )
  })

  test('property: moving the as-of date moves every report by the same days, at the same clock time', () => {
    fc.assert(
      fc.property(inputsArbitrary, fc.integer({ min: -400, max: 400 }), (inputs, shiftDays) => {
        const localClockOf = (instant: DateTime.Utc | null): readonly [string, string] => {
          const zoned = DateTime.unsafeMakeZoned(instant ?? 0, {
            timeZone: defaultLifeLabsPdfSettings.timeZone,
          })
          const iso = DateTime.formatIsoZoned(zoned)
          return [iso.slice(0, 10), iso.slice(11, 16)]
        }
        const shiftedAsOf = DateTime.add(inputs.asOf, { days: shiftDays })
        const shifted = diagnosticReportsIn(renderOf({ ...inputs, asOf: shiftedAsOf }))
        const original = diagnosticReportsIn(renderOf(inputs))
        expect(shifted).toHaveLength(original.length)
        original.forEach((report, index) => {
          const shiftedReport = shifted[index]
          for (const pick of [
            (it: DiagnosticReport.Type | undefined) => it?.effectiveDateTime ?? null,
            (it: DiagnosticReport.Type | undefined) => it?.issued ?? null,
          ]) {
            const [date, clock] = localClockOf(pick(report))
            const [shiftedDate, shiftedClock] = localClockOf(pick(shiftedReport))
            expect(shiftedClock).toBe(clock)
            expect((Date.parse(shiftedDate) - Date.parse(date)) / 86_400_000).toBe(shiftDays)
          }
        })
      }),
      { numRuns: RUNS }
    )
  })
})

describe('LifeLabs.reportsOf', () => {
  test('property: are the reports the importer reads back off their print, and render is its decode without the Patient', () => {
    fc.assert(
      fc.property(inputsArbitrary, (inputs) => {
        const { laboratory, story } = inputs.storyWithLaboratory
        const reports = Effect.runSync(
          LifeLabs.reportsOf(inputs.asOf, story, laboratory, inputs.requisition)
        )
        const printed = layoutDocument(reports)
        const readBack = Effect.runSync(Report.tryFromDocument(printed))
        expect(readBack.map((report) => ({ ...report, pageNumbers: [] }))).toEqual(
          reports.map((report) => ({ ...report, pageNumbers: [] }))
        )

        const decoded = Effect.runSync(
          decodeLifeLabsPdfDocument(printed, defaultLifeLabsPdfSettings)
        )
        const imported = decoded.sections.flatMap((section) =>
          section.resources.map((entry) => entry.resource)
        )
        const withoutSubject = (resource: FhirResource): FhirResource =>
          resource.resourceType === 'Observation' || resource.resourceType === 'DiagnosticReport'
            ? { ...resource, subject: null }
            : resource
        expect(renderOf(inputs).map(withoutSubject)).toEqual(
          imported.filter((resource) => resource.resourceType !== 'Patient').map(withoutSubject)
        )
      }),
      { numRuns: RUNS }
    )
  })

  test('fails when a draw names a test the laboratory does not print', () => {
    const laboratory: Laboratory.Laboratory = { addressLines: [], licence: '#5687', tests: [] }
    const story = storyDrawing({ day: -1, test: 'Sodium', value: 140, unit: 'mmol/L' })
    const failure = Effect.runSync(
      Effect.flip(
        LifeLabs.reportsOf(DateTime.unsafeMake('2026-09-28T12:00:00Z'), story, laboratory, {
          orderedBy: 'ROY DR. ANNE',
          copyTo: [],
        })
      )
    )
    expect(failure).toBeInstanceOf(LifeLabs.UncataloguedLabTest)
    expect(failure.test).toBe('Sodium')
  })
})

describe('LifeLabsLaboratory.flagOf and printRange', () => {
  test.each([
    { range: Laboratory.between('3.50', '5.00'), value: 3.49, flag: 'LO', printed: '3.50 - 5.00' },
    { range: Laboratory.between('3.50', '5.00'), value: 3.5, flag: '', printed: '3.50 - 5.00' },
    { range: Laboratory.between('3.50', '5.00'), value: 5, flag: '', printed: '3.50 - 5.00' },
    { range: Laboratory.between('3.50', '5.00'), value: 5.01, flag: 'HI', printed: '3.50 - 5.00' },
    { range: Laboratory.below('3.50'), value: 3.49, flag: '', printed: '<3.50' },
    { range: Laboratory.below('3.50'), value: 3.5, flag: 'HI', printed: '<3.50' },
    { range: Laboratory.atLeast('60'), value: 59, flag: 'LO', printed: '>=60' },
    { range: Laboratory.atLeast('60'), value: 60, flag: '', printed: '>=60' },
  ] as const)('$value against $printed flags "$flag"', ({ range, value, flag, printed }) => {
    expect(Laboratory.flagOf(value, range)).toBe(flag)
    expect(Laboratory.printRange(range)).toBe(printed)
  })
})

describe('LifeLabs.reportsOf flag', () => {
  test('is read off the printed result when the value rounds onto a bound', () => {
    const laboratory: Laboratory.Laboratory = {
      addressLines: [],
      licence: '#5687',
      tests: [
        {
          storyTest: 'TSH',
          name: 'TSH',
          section: 'Endocrinology',
          group: '',
          decimals: 2,
          range: Laboratory.eitherSex(Laboratory.between('0.32', '4.00')),
          comments: [],
        },
      ],
    }
    const story = storyDrawing({ day: -1, test: 'TSH', value: 4.004, unit: 'mIU/L' })
    const [report] = Effect.runSync(
      LifeLabs.reportsOf(DateTime.unsafeMake('2026-09-28T12:00:00Z'), story, laboratory, {
        orderedBy: 'ROY DR. ANNE',
        copyTo: [],
      })
    )
    const [row] = report?.sections[0]?.groups[0]?.rows ?? []
    expect({ result: row?.result, flag: row?.flag }).toEqual({ result: '4.00', flag: '' })
  })
})
