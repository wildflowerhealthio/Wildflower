import { HealthCardIdentifier } from '@wildflowerhealthio/fhir-ca-infoway'
import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as LabNumber from '../entities/lab-number.ts'
import { arbitrary as reportArbitrary } from '../entities/report-arbitrary.ts'
import type * as Report from '../entities/report.ts'
import type * as TestTableRow from '../entities/test-table-row.ts'
import { LifeLabsIdentifierSystem } from '../source-system.ts'
import {
  observationKeyOf,
  patientKeyOf,
  practitionerKeyOf,
  reportKeyOf,
  type ReportResources,
  type SynthesisOptions,
  toFhirResources,
} from './to-fhir.ts'
import { UCUM_SYSTEM } from './units.ts'

const OPTIONS: SynthesisOptions = { timeZone: 'America/Toronto', healthCardProvince: 'ON' }

const ONTARIO_HEALTH_CARD = HealthCardIdentifier.HealthCardNumberSystem.ON

/** The key `patient` is given with its card from `province`, for a card of that province's shape. */
const patientKeyIn = (
  patient: Report.Type['patient'],
  province: SynthesisOptions['healthCardProvince']
): DetachedResource.Key => Effect.runSync(patientKeyOf(patient, province))

/** A group's resources, in order; none for no group. */
const resourcesOf = (group: ReportResources | undefined): readonly FhirResource[] =>
  group?.entries.map(({ resource }) => resource) ?? []

/** The synthesized groups flattened in order — most assertions read the whole set. */
const synthesize = (
  reports: readonly Report.Type[],
  options: SynthesisOptions = OPTIONS
): readonly FhirResource[] => Effect.runSync(toFhirResources(reports, options)).flatMap(resourcesOf)

const ofType = <T extends FhirResource['resourceType']>(
  resources: readonly FhirResource[],
  resourceType: T
): readonly Extract<FhirResource, { resourceType: T }>[] =>
  resources.filter(
    (resource): resource is Extract<FhirResource, { resourceType: T }> =>
      resource.resourceType === resourceType
  )

/** `key` as `<system>|<value>`, the spelling the helpers below compare keys in. */
const keyText = ({ system, value }: DetachedResource.Key): string => `${system}|${value}`

/** An identifier as `<system>|<value>`, or `null` when it has neither. */
const identifierText = (
  identifier: { readonly system: URL | null; readonly value: string | null } | null | undefined
): string | null =>
  identifier?.system == null || identifier.value === null
    ? null
    : `${identifier.system.href}|${identifier.value}`

/** The key the synthesis gave `resource`, `identifier[0]`, as `<system>|<value>`. */
const idOf = (resource: FhirResource | undefined): string | null =>
  resource !== undefined && 'identifier' in resource ? identifierText(resource.identifier[0]) : null

/** The key of the record `reference` names: its logical reference's identifier. */
const targetOf = (
  reference:
    | {
        readonly identifier: { readonly system: URL | null; readonly value: string | null } | null
      }
    | null
    | undefined
): string | null => identifierText(reference?.identifier)

const hemoglobinRow: TestTableRow.Type = {
  name: 'Hemoglobin',
  flag: 'LO',
  result: '118',
  referenceRange: '120- 160',
  unit: 'g/L',
  labLicence: '#5687',
  comments: [],
}

const sample: Report.Type = {
  labNo: LabNumber.make('2024-JJ6330780'),
  referenceNumber: '',
  referringSiteId: '',
  patient: {
    name: 'OKAFOR, DANA MARIE',
    age: '45 years',
    sex: 'F',
    dateOfBirth: 'Aug 13 1981',
    healthCardNumber: '1234567890 AB',
    phone: '(416) 555-0100',
    patientId: '',
  },
  orderedBy: 'HAMILTON-REYES DR. SAM',
  copyTo: ['NGUYEN DR. LEE'],
  dateOfService: 'Aug 13 2026 13:02',
  reportedOn: 'Aug 14 2026 18:21',
  lab: {
    addressLines: ['100 International Blvd.', 'Toronto, Ontario', 'Canada M9W 6J6'],
    telephone: '',
    tollFree: '',
    fax: '',
  },
  status: 'FINAL RESULTS',
  pageNumbers: [1],
  sections: [
    {
      name: 'Hematology',
      comments: [],
      groups: [
        {
          name: '',
          rows: [hemoglobinRow],
        },
        {
          name: 'Differential',
          rows: [
            {
              name: 'Immature Granulocytes',
              flag: '',
              result: '<0.1',
              referenceRange: '<0.1',
              unit: 'x E9/L',
              labLicence: '#5687',
              comments: [],
            },
          ],
        },
      ],
    },
    {
      name: 'Molecular Biology',
      comments: [],
      groups: [
        {
          name: 'Chlamydia Investigation Urine',
          rows: [
            {
              name: 'Chlamydia trachomatis DNA (NAAT) Urine',
              flag: '',
              result: 'NEGATIVE',
              referenceRange: '',
              unit: '',
              labLicence: '#5407',
              comments: ['A negative result indicates that nucleic acids', 'are absent.'],
            },
          ],
        },
      ],
    },
  ],
}

/** Arrays of reports, each printing its own lab number. */
const reportsArbitrary = fc.uniqueArray(reportArbitrary, {
  minLength: 1,
  maxLength: 3,
  selector: (report) => report.labNo,
})

describe('toFhirResources', () => {
  it('property: every row is one Observation the report lists, on the one Patient, and every key is unique', () => {
    fc.assert(
      fc.property(reportsArbitrary, (reports) => {
        const resources = synthesize(reports)

        const keys = resources.map((resource) => `${resource.resourceType}/${idOf(resource)}`)
        expect(new Set(keys).size).toBe(keys.length)

        const observations = ofType(resources, 'Observation')
        const rowCount = reports.reduce(
          (count, report) =>
            count +
            report.sections.reduce(
              (c, section) => c + section.groups.reduce((n, group) => n + group.rows.length, 0),
              0
            ),
          0
        )
        expect(observations).toHaveLength(rowCount)

        const diagnosticReports = ofType(resources, 'DiagnosticReport')
        expect(diagnosticReports).toHaveLength(reports.length)
        const listed = diagnosticReports.flatMap((report) =>
          report.result.map((reference) => `Observation/${targetOf(reference)}`)
        )
        const byText = (a: string | null, b: string | null): number =>
          (a ?? '').localeCompare(b ?? '')
        expect(listed.toSorted(byText)).toEqual(
          observations.map((observation) => `Observation/${idOf(observation)}`).toSorted(byText)
        )

        const patientIds = new Set(ofType(resources, 'Patient').map(idOf))
        for (const observation of [...observations, ...diagnosticReports]) {
          expect(patientIds.has(targetOf(observation.subject))).toBe(true)
        }

        // Every resultsInterpreter reference resolves to a Practitioner minted
        // somewhere in the batch — a provider deduped into an earlier report's
        // group is still present once the groups are flattened.
        const practitionerIds = new Set(ofType(resources, 'Practitioner').map(idOf))
        for (const report of diagnosticReports) {
          for (const interpreter of report.resultsInterpreter) {
            expect(practitionerIds.has(targetOf(interpreter))).toBe(true)
          }
        }
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  }, 60_000)

  it('property: a re-synthesis writes the same keys — the report determines them', () => {
    fc.assert(
      fc.property(reportArbitrary, (report) => {
        const first = synthesize([report]).map((r) => `${r.resourceType}/${idOf(r)}`)
        const again = synthesize([report]).map((r) => `${r.resourceType}/${idOf(r)}`)
        expect(again).toEqual(first)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('keys a report by the lab number it prints', () => {
    expect(reportKeyOf(sample)).toEqual({
      system: LifeLabsIdentifierSystem.LabNumber,
      value: '2024-JJ6330780',
    })
  })

  it('emits each practitioner and patient once across reports that share them', () => {
    const resources = synthesize([sample, { ...sample, labNo: LabNumber.make('2024-JJ0000001') }])

    expect(ofType(resources, 'Patient')).toHaveLength(1)
    expect(ofType(resources, 'Practitioner').map((p) => p.name[0]?.text)).toEqual([
      'HAMILTON-REYES DR. SAM',
      'NGUYEN DR. LEE',
    ])
    expect(ofType(resources, 'DiagnosticReport')).toHaveLength(2)
  })

  it('builds the Patient from the header: name parts, gender, birth date, health card, phone', () => {
    const [patient] = ofType(synthesize([sample]), 'Patient')

    expect(patient?.id).toBeNull()
    expect(idOf(patient)).toBe(keyText(patientKeyIn(sample.patient, 'ON')))
    expect(patient?.name[0]).toMatchObject({
      family: 'OKAFOR',
      given: ['DANA', 'MARIE'],
      text: 'OKAFOR, DANA MARIE',
    })
    expect(patient?.gender).toBe('female')
    expect(patient?.birthDate).toBe('1981-08-13')
    // The health card number, less its version code, is the key, written once,
    // its version code in Ontario's extension.
    expect(patient?.identifier).toEqual([
      expect.objectContaining({
        system: new URL(ONTARIO_HEALTH_CARD),
        value: '1234567890',
        extension: [
          expect.objectContaining({
            url: HealthCardIdentifier.ONTARIO_HEALTH_CARD_VERSION_CODE_URL,
            valueString: 'AB',
          }),
        ],
      }),
    ])
    expect(patient?.telecom[0]).toMatchObject({ system: 'phone', value: '(416) 555-0100' })
    // The report's providers are the DiagnosticReport's resultsInterpreter, not
    // the patient's GP — a lab report names who to send results to, not who the
    // patient's family doctor is.
    expect(patient?.generalPractitioner).toEqual([])
  })

  it('keys a patient by Patient ID first, then health card number, then name and birth date', () => {
    expect(patientKeyIn({ ...sample.patient, patientId: 'P-77' }, 'ON')).toEqual({
      system: LifeLabsIdentifierSystem.PatientId,
      value: 'P-77',
    })
    expect(patientKeyIn(sample.patient, 'ON')).toEqual({
      system: ONTARIO_HEALTH_CARD,
      value: '1234567890',
    })
    expect(
      patientKeyIn({ ...sample.patient, name: ' OKAFOR, DANA MARIE ', healthCardNumber: '' }, 'ON')
    ).toEqual({
      system: LifeLabsIdentifierSystem.PatientNameBirthDate,
      value: 'OKAFOR, DANA MARIE, Aug 13 1981',
    })
  })

  it('writes the other identifiers the report prints behind the key, the key once', () => {
    const [patient] = ofType(
      synthesize([{ ...sample, patient: { ...sample.patient, patientId: 'P-77' } }]),
      'Patient'
    )

    expect(patient?.identifier.map(identifierText)).toEqual([
      `${LifeLabsIdentifierSystem.PatientId}|P-77`,
      `${ONTARIO_HEALTH_CARD}|1234567890`,
    ])
  })

  it('keys one Patient for two version codes of one health card number, however it is spaced', () => {
    const reissued = { ...sample.patient, healthCardNumber: '1234567890AC' }
    const resources = synthesize([
      sample,
      { ...sample, labNo: LabNumber.make('2024-JJ0000001'), patient: reissued },
    ])

    expect(patientKeyIn(reissued, 'ON')).toEqual(patientKeyIn(sample.patient, 'ON'))
    expect(ofType(resources, 'Patient')).toHaveLength(1)
    expect(ofType(resources, 'DiagnosticReport').map((report) => targetOf(report.subject))).toEqual(
      [`${ONTARIO_HEALTH_CARD}|1234567890`, `${ONTARIO_HEALTH_CARD}|1234567890`]
    )
    expect(
      patientKeyIn({ ...sample.patient, healthCardNumber: '1234-567-890 A' }, 'ON').value
    ).toBe('1234567890')
  })

  it("writes a shared Patient's version code from the latest report naming it", () => {
    const versionCodesOf = (reports: readonly Report.Type[]): readonly unknown[] =>
      ofType(synthesize(reports), 'Patient').flatMap((patient) =>
        patient.identifier.flatMap((identifier) =>
          identifier.extension.map((extension) => extension.valueString)
        )
      )
    const reissued: Report.Type = {
      ...sample,
      labNo: LabNumber.make('2024-JJ0000001'),
      reportedOn: 'Sep 1 2026 10:00',
      patient: { ...sample.patient, healthCardNumber: '1234567890 AC' },
    }

    // The reissued card's report is later, wherever it is in the document.
    expect(versionCodesOf([reissued, sample])).toEqual(['AC'])
    expect(versionCodesOf([sample, reissued])).toEqual(['AC'])
    // Reported at once, the earlier in the document.
    expect(versionCodesOf([sample, { ...reissued, reportedOn: sample.reportedOn }])).toEqual(['AB'])
  })

  it("writes the health card number in British Columbia's system when British Columbia is chosen", () => {
    const british = { ...sample.patient, healthCardNumber: '9123456789' }
    const [patient] = ofType(
      synthesize([{ ...sample, patient: british }], { ...OPTIONS, healthCardProvince: 'BC' }),
      'Patient'
    )

    expect(patientKeyIn(british, 'BC')).toEqual({
      system: HealthCardIdentifier.HealthCardNumberSystem.BC,
      value: '9123456789',
    })
    expect(patient?.identifier).toEqual([
      expect.objectContaining({
        system: new URL(HealthCardIdentifier.HealthCardNumberSystem.BC),
        value: '9123456789',
        extension: [],
      }),
    ])
  })

  it('keys a practitioner by the printed name, inner whitespace collapsed', () => {
    expect(practitionerKeyOf('  HAMILTON-REYES   DR.\tSAM ')).toEqual({
      system: LifeLabsIdentifierSystem.PractitionerName,
      value: 'HAMILTON-REYES DR. SAM',
    })
  })

  it('keys a result row by lab number, section, test name and ordinal, as printed', () => {
    const [, granulocytes] = ofType(synthesize([sample]), 'Observation')

    expect(idOf(granulocytes)).toBe(
      `${LifeLabsIdentifierSystem.Observation}|2024-JJ6330780/Hematology/Immature Granulocytes/1`
    )
    expect(observationKeyOf(sample, 'Hematology', hemoglobinRow, 0)).toEqual({
      system: LifeLabsIdentifierSystem.Observation,
      value: '2024-JJ6330780/Hematology/Hemoglobin/0',
    })
  })

  it('builds the DiagnosticReport: lab number, LOINC code, sections as text, timing in the zone, results, performer, resultsInterpreter', () => {
    const [report] = ofType(synthesize([sample]), 'DiagnosticReport')

    expect(idOf(report)).toBe(`${LifeLabsIdentifierSystem.LabNumber}|2024-JJ6330780`)
    expect(report?.status).toBe('final')
    expect(report?.identifier).toHaveLength(1)
    expect(report?.code.coding[0]).toMatchObject({ code: '11502-2', display: 'Laboratory report' })
    expect(report?.code.text).toBe('Hematology, Molecular Biology')
    expect(report?.effectiveDateTime).toEqual(
      Option.getOrThrow(Option.some(report?.effectiveDateTime))
    )
    expect(report?.effectiveDateTime?.epochMillis).toBe(Date.parse('2026-08-13T17:02:00.000Z'))
    expect(report?.issued?.epochMillis).toBe(Date.parse('2026-08-14T22:21:00.000Z'))
    expect(report?.result).toHaveLength(3)
    expect(report?.performer.map((p) => p.display)).toEqual([
      'Lab Lic. #5687 · 100 International Blvd., Toronto, Ontario, Canada M9W 6J6',
      'Lab Lic. #5407 · 100 International Blvd., Toronto, Ontario, Canada M9W 6J6',
    ])
    // Every provider named on the report — the ordering provider and each CC'd
    // provider — is a resultsInterpreter reference, in that order.
    expect(report?.resultsInterpreter.map(targetOf)).toEqual([
      keyText(practitionerKeyOf(sample.orderedBy)),
      keyText(practitionerKeyOf(sample.copyTo[0] ?? '')),
    ])
  })

  it('reads a report with no FINAL footer as status unknown', () => {
    const [report] = ofType(synthesize([{ ...sample, status: '' }]), 'DiagnosticReport')
    expect(report?.status).toBe('unknown')
    expect(ofType(synthesize([{ ...sample, status: '' }]), 'Observation')[0]?.status).toBe(
      'unknown'
    )
  })

  it('builds a numeric Observation: quantity with unit and UCUM coding, interpretation from the flag, bounded reference range that carries the same coding', () => {
    const [hemoglobin] = ofType(synthesize([sample]), 'Observation')

    expect(hemoglobin?.code.text).toBe('Hemoglobin')
    expect(hemoglobin?.category[0]?.text).toBe('Hematology')
    expect(hemoglobin?.valueQuantity).toMatchObject({
      value: 118,
      unit: 'g/L',
      system: UCUM_SYSTEM,
      code: 'g/L',
      comparator: null,
    })
    expect(hemoglobin?.interpretation[0]?.coding[0]).toMatchObject({ code: 'L', display: 'Low' })
    expect(hemoglobin?.referenceRange[0]).toMatchObject({
      low: { value: 120, unit: 'g/L', system: UCUM_SYSTEM, code: 'g/L' },
      high: { value: 160, unit: 'g/L', system: UCUM_SYSTEM, code: 'g/L' },
      text: '120- 160',
    })
    expect(hemoglobin?.performer[0]?.display).toContain('#5687')
    expect(hemoglobin?.note).toEqual([])
  })

  it('carries a censored result as a comparator, and a group name into the category text', () => {
    const [, granulocytes] = ofType(synthesize([sample]), 'Observation')

    // `x E9/L` is a mapped display, so the quantity picks up the UCUM code.
    expect(granulocytes?.valueQuantity).toMatchObject({
      value: 0.1,
      unit: 'x E9/L',
      system: UCUM_SYSTEM,
      code: '10*9/L',
      comparator: '<',
    })
    expect(granulocytes?.category[0]?.text).toBe('Hematology · Differential')
    expect(granulocytes?.referenceRange[0]).toMatchObject({
      low: null,
      high: { value: 0.1, unit: 'x E9/L', system: UCUM_SYSTEM, code: '10*9/L' },
    })
  })

  it('carries an unmapped display unit as `unit` alone — never guesses a UCUM code', () => {
    const unmapped: Report.Type = {
      ...sample,
      sections: [
        {
          name: 'Hematology',
          comments: [],
          groups: [
            {
              name: '',
              rows: [
                {
                  name: 'Custom test',
                  flag: '',
                  result: '42',
                  referenceRange: '10- 50',
                  unit: 'made-up unit',
                  labLicence: '#5687',
                  comments: [],
                },
              ],
            },
          ],
        },
      ],
    }
    const [observation] = ofType(synthesize([unmapped]), 'Observation')
    expect(observation?.valueQuantity).toMatchObject({
      value: 42,
      unit: 'made-up unit',
      system: null,
      code: null,
    })
    expect(observation?.referenceRange[0]).toMatchObject({
      low: { value: 10, unit: 'made-up unit', system: null, code: null },
      high: { value: 50, unit: 'made-up unit', system: null, code: null },
    })
  })

  it('builds a text Observation: valueString, no range, the comments as one note', () => {
    const [, , chlamydia] = ofType(synthesize([sample]), 'Observation')

    expect(chlamydia?.valueString).toBe('NEGATIVE')
    expect(chlamydia?.valueQuantity).toBeNull()
    expect(chlamydia?.referenceRange).toEqual([])
    expect(chlamydia?.interpretation).toEqual([])
    expect(chlamydia?.note[0]?.text).toBe(
      'A negative result indicates that nucleic acids\nare absent.'
    )
  })

  it('leaves masked or absent header fields off the resources rather than inventing them', () => {
    const masked: Report.Type = {
      ...sample,
      patient: {
        ...sample.patient,
        dateOfBirth: 'Xxx 00 0000',
        sex: '',
        phone: '',
        healthCardNumber: '',
      },
      orderedBy: '',
      copyTo: [],
      dateOfService: '',
      reportedOn: '',
    }

    const resources = synthesize([masked])
    const [patient] = ofType(resources, 'Patient')
    const [report] = ofType(resources, 'DiagnosticReport')

    expect(ofType(resources, 'Practitioner')).toEqual([])
    expect(patient?.birthDate).toBeNull()
    expect(patient?.gender).toBeNull()
    expect(patient?.telecom).toEqual([])
    // Only the key, by name and the birth date as printed: no identifier the
    // header masked.
    expect(patient?.identifier.map(identifierText)).toEqual([
      `${LifeLabsIdentifierSystem.PatientNameBirthDate}|OKAFOR, DANA MARIE, Xxx 00 0000`,
    ])
    expect(patient?.generalPractitioner).toEqual([])
    expect(report?.resultsInterpreter).toEqual([])
    expect(report?.effectiveDateTime).toBeNull()
    expect(report?.issued).toBeNull()
  })

  it("leaves an unheaded row's category without text", () => {
    const unheaded: Report.Type = {
      ...sample,
      sections: [{ name: '', comments: [], groups: [{ name: '', rows: [hemoglobinRow] }] }],
    }

    const [observation] = ofType(synthesize([unheaded]), 'Observation')

    expect(observation?.category[0]?.coding[0]?.code).toBe('laboratory')
    expect(observation?.category[0]?.text).toBeNull()
  })

  it('property: a report whose rows print a licence lists one performer per licence, none without', () => {
    fc.assert(
      fc.property(reportArbitrary, (report) => {
        const printed = new Set(
          report.sections.flatMap((section) =>
            section.groups.flatMap((group) => group.rows.map((row) => row.labLicence))
          )
        )
        printed.delete('')
        fc.pre(printed.size > 0)

        const [diagnosticReport] = ofType(synthesize([report]), 'DiagnosticReport')

        expect(
          diagnosticReport?.performer.map((performer) => performer.display?.split(' · ')[0])
        ).toEqual([...printed].map((licence) => `Lab Lic. ${licence}`))
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('lists the lab once as performer when rows above the first printed licence carry none', () => {
    const [report] = ofType(
      synthesize([
        {
          ...sample,
          sections: [
            {
              name: 'Hematology',
              comments: [],
              groups: [{ name: '', rows: [{ ...hemoglobinRow, labLicence: '' }, hemoglobinRow] }],
            },
          ],
        },
      ]),
      'DiagnosticReport'
    )

    expect(report?.performer.map((p) => p.display)).toEqual([
      'Lab Lic. #5687 · 100 International Blvd., Toronto, Ontario, Canada M9W 6J6',
    ])
  })

  it('groups each report with its own resources, minting a shared Patient in the first group only', () => {
    const second = { ...sample, labNo: LabNumber.make('2024-JJ0000001') }

    const groups = Effect.runSync(toFhirResources([sample, second], OPTIONS))

    expect(groups.map((group) => group.report)).toEqual([sample, second])
    const [first, again] = groups
    // The two reports name the same patient and practitioners — deduplicated
    // by key, they appear in the first group and never again.
    expect(ofType(resourcesOf(first), 'Patient')).toHaveLength(1)
    expect(ofType(resourcesOf(again), 'Patient')).toHaveLength(0)
    expect(ofType(resourcesOf(again), 'Practitioner')).toHaveLength(0)
    // Each group still carries its own DiagnosticReport and Observations.
    expect(ofType(resourcesOf(first), 'DiagnosticReport')).toHaveLength(1)
    expect(ofType(resourcesOf(again), 'DiagnosticReport')).toHaveLength(1)
  })
})
