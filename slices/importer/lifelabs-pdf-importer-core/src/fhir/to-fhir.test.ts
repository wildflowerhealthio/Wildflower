import { Effect, Option } from 'effect'
import * as fc from 'fast-check'
import type { FhirResource } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { reportArbitrary } from '../dialect/report-arbitrary.ts'
import type { LifeLabsReport } from '../dialect/report.ts'
import { LifeLabsIdentifierSystem } from '../source-system.ts'
import {
  patientOriginalId,
  practitionerOriginalId,
  reportOriginalId,
  toFhirResources,
} from './to-fhir.ts'

const TIME_ZONE = 'America/Toronto'

const synthesize = (reports: readonly LifeLabsReport[]): readonly FhirResource[] =>
  Effect.runSync(toFhirResources(reports, { timeZone: TIME_ZONE }))

const ofType = <T extends FhirResource['resourceType']>(
  resources: readonly FhirResource[],
  resourceType: T
): readonly Extract<FhirResource, { resourceType: T }>[] =>
  resources.filter(
    (resource): resource is Extract<FhirResource, { resourceType: T }> =>
      resource.resourceType === resourceType
  )

/** One fully-populated report, the example tests read resources off. */
const sample: LifeLabsReport = {
  labNo: '2024-JJ6330780',
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
          rows: [
            {
              name: 'Hemoglobin',
              flag: 'LO',
              result: '118',
              referenceRange: '120- 160',
              unit: 'g/L',
              labLicence: '#5687',
              comments: [],
            },
          ],
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

describe('toFhirResources', () => {
  it('property: every row is one Observation the report lists, on the one Patient, and every id is unique', () => {
    fc.assert(
      fc.property(fc.array(reportArbitrary, { minLength: 1, maxLength: 3 }), (reports) => {
        const resources = synthesize(reports)

        const ids = resources.map((resource) => `${resource.resourceType}/${resource.id}`)
        expect(new Set(ids).size).toBe(ids.length)

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
          report.result.map((reference) => reference.reference)
        )
        const byText = (a: string | null, b: string | null): number =>
          (a ?? '').localeCompare(b ?? '')
        expect(listed.toSorted(byText)).toEqual(
          observations.map((observation) => `Observation/${observation.id}`).toSorted(byText)
        )

        const patientIds = new Set(ofType(resources, 'Patient').map((patient) => patient.id))
        for (const observation of [...observations, ...diagnosticReports]) {
          const subject = observation.subject?.reference ?? ''
          expect(patientIds.has(subject.replace(/^Patient\//, ''))).toBe(true)
        }
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  }, 60_000)

  it('property: a re-synthesis mints the same ids — the report determines them', () => {
    fc.assert(
      fc.property(reportArbitrary, (report) => {
        const first = synthesize([report]).map((r) => `${r.resourceType}/${r.id}`)
        const again = synthesize([report]).map((r) => `${r.resourceType}/${r.id}`)
        expect(again).toEqual(first)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('emits each practitioner and patient once across reports that share them', () => {
    const resources = synthesize([sample, { ...sample, labNo: '2024-JJ0000001' }])

    expect(ofType(resources, 'Patient')).toHaveLength(1)
    expect(ofType(resources, 'Practitioner').map((p) => p.name[0]?.text)).toEqual([
      'HAMILTON-REYES DR. SAM',
      'NGUYEN DR. LEE',
    ])
    expect(ofType(resources, 'DiagnosticReport')).toHaveLength(2)
  })

  it('builds the Patient from the header: name parts, gender, birth date, health card, phone, GP', () => {
    const [patient] = ofType(synthesize([sample]), 'Patient')

    expect(patient?.id).toBe(patientOriginalId(sample.patient))
    expect(patient?.name[0]).toMatchObject({
      family: 'OKAFOR',
      given: ['DANA', 'MARIE'],
      text: 'OKAFOR, DANA MARIE',
    })
    expect(patient?.gender).toBe('female')
    expect(patient?.birthDate).toBe('1981-08-13')
    expect(patient?.identifier[0]).toMatchObject({
      system: new URL(LifeLabsIdentifierSystem.OntarioHealthCardNumber),
      value: '1234567890 AB',
    })
    expect(patient?.telecom[0]).toMatchObject({ system: 'phone', value: '(416) 555-0100' })
    expect(patient?.generalPractitioner[0]?.reference).toBe(
      `Practitioner/${practitionerOriginalId(sample.orderedBy)}`
    )
  })

  it('keys a patient by Patient ID first, then health card digits, then name and birth date', () => {
    const byPatientId = patientOriginalId({ ...sample.patient, patientId: 'P-77' })
    const byHealthCard = patientOriginalId(sample.patient)
    const byName = patientOriginalId({ ...sample.patient, healthCardNumber: '' })

    // The same Patient ID keys the same patient whatever else the header says.
    expect(patientOriginalId({ ...sample.patient, patientId: 'P-77', name: 'OTHER, ONE' })).toBe(
      byPatientId
    )
    // A health card number keys by its digits alone — the version code varies.
    expect(patientOriginalId({ ...sample.patient, healthCardNumber: '1234567890 AC' })).toBe(
      byHealthCard
    )
    expect(byName).toBe(patientOriginalId({ ...sample.patient, healthCardNumber: '' }))
    expect(byName).not.toBe(
      patientOriginalId({ ...sample.patient, healthCardNumber: '', dateOfBirth: 'Aug 14 1981' })
    )
    expect(new Set([byPatientId, byHealthCard, byName]).size).toBe(3)
  })

  it('property: every minted id is a FHIR id, so adoption can rewrite the references that carry it', () => {
    fc.assert(
      fc.property(reportArbitrary, (report) => {
        for (const resource of synthesize([report])) {
          expect(resource.id).toMatch(/^[A-Za-z0-9\-.]{1,64}$/)
        }
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('builds the DiagnosticReport: lab number, LOINC code, sections as text, timing in the zone, results, performer', () => {
    const [report] = ofType(synthesize([sample]), 'DiagnosticReport')

    expect(report?.id).toBe(reportOriginalId(sample))
    expect(report?.status).toBe('final')
    expect(report?.identifier[0]).toMatchObject({
      system: new URL(LifeLabsIdentifierSystem.LabNumber),
      value: '2024-JJ6330780',
    })
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
  })

  it('reads a report with no FINAL footer as status unknown', () => {
    const [report] = ofType(synthesize([{ ...sample, status: '' }]), 'DiagnosticReport')
    expect(report?.status).toBe('unknown')
    expect(ofType(synthesize([{ ...sample, status: '' }]), 'Observation')[0]?.status).toBe(
      'unknown'
    )
  })

  it('builds a numeric Observation: quantity with unit, interpretation from the flag, bounded reference range', () => {
    const [hemoglobin] = ofType(synthesize([sample]), 'Observation')

    expect(hemoglobin?.code.text).toBe('Hemoglobin')
    expect(hemoglobin?.category[0]?.text).toBe('Hematology')
    expect(hemoglobin?.valueQuantity).toMatchObject({ value: 118, unit: 'g/L', comparator: null })
    expect(hemoglobin?.interpretation[0]?.coding[0]).toMatchObject({ code: 'L', display: 'Low' })
    expect(hemoglobin?.referenceRange[0]).toMatchObject({
      low: { value: 120, unit: 'g/L' },
      high: { value: 160, unit: 'g/L' },
      text: '120- 160',
    })
    expect(hemoglobin?.performer[0]?.display).toContain('#5687')
    expect(hemoglobin?.note).toEqual([])
  })

  it('carries a censored result as a comparator, and a group name into the category text', () => {
    const [, granulocytes] = ofType(synthesize([sample]), 'Observation')

    expect(granulocytes?.valueQuantity).toMatchObject({ value: 0.1, comparator: '<' })
    expect(granulocytes?.category[0]?.text).toBe('Hematology · Differential')
    expect(granulocytes?.referenceRange[0]).toMatchObject({ low: null, high: { value: 0.1 } })
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
    const masked: LifeLabsReport = {
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
    expect(patient?.identifier).toEqual([])
    expect(patient?.generalPractitioner).toEqual([])
    expect(report?.effectiveDateTime).toBeNull()
    expect(report?.issued).toBeNull()
  })
})
