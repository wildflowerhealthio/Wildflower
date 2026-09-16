import type { DicomHeader } from 'dicom'
import { dicomHeaderArb } from 'dicom/test-helpers'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { DicomSettings } from '../settings.ts'
import { fhirDate, fhirDateTime, patientOriginalId, toFhirResources } from './to-fhir.ts'

/**
 * A fixed zone rather than `defaultDicomSettings`, whose `timeZone` is the
 * runtime's own — an assertion on a resolved instant has to name the zone it
 * was resolved against or it passes only on the machine that wrote it.
 * `America/Toronto` observes DST, so it also exercises the offset actually
 * changing across the year.
 */
const SETTINGS: DicomSettings = { timeZone: 'America/Toronto' }

const minimalHeader = (overrides: Partial<DicomHeader> = {}): DicomHeader => ({
  patientName: { family: 'Doe', given: 'John', text: 'Doe John' },
  patientId: 'P001',
  issuerOfPatientId: undefined,
  patientBirthDate: '19800101',
  patientSex: 'M',
  studyInstanceUid: '1.2.3.4.5',
  studyDate: '20240315',
  studyTime: '143022',
  studyDescription: 'CT Chest',
  accessionNumber: 'ACC001',
  referringPhysicianName: { family: 'Smith', given: 'Jane', text: 'Smith Jane' },
  requestedProcedureDescription: 'CT of Chest',
  hasRequestAttributesSequence: false,
  seriesInstanceUid: '1.2.3.4.5.1',
  seriesNumber: 1,
  seriesDescription: 'Axial',
  modality: 'CT',
  bodyPartExamined: 'CHEST',
  sopInstanceUid: '1.2.3.4.5.1.1',
  sopClassUid: '1.2.840.10008.5.1.4.1.1.2',
  instanceNumber: 1,
  rows: 512,
  columns: 512,
  numberOfFrames: undefined,
  transferSyntaxUid: '1.2.840.10008.1.2.1',
  manufacturer: 'GE MEDICAL SYSTEMS',
  manufacturerModelName: 'Discovery',
  institutionName: 'Test Hospital',
  ...overrides,
})

describe('toFhirResources', () => {
  it('produces deterministic ids from the same tags (property)', () => {
    fc.assert(
      fc.property(
        dicomHeaderArb().filter((h) => patientOriginalId(h) !== undefined),
        (header) => {
          const run1 = Effect.runSync(toFhirResources(header, SETTINGS))
          const run2 = Effect.runSync(toFhirResources(header, SETTINGS))
          expect(run1.map((r) => r.id)).toEqual(run2.map((r) => r.id))
        }
      ),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('emits Patient, ServiceRequest, ImagingStudy when AccessionNumber is present', async () => {
    const resources = await Effect.runPromise(toFhirResources(minimalHeader(), SETTINGS))
    const types = resources.map((r) => r.resourceType)
    expect(types).toEqual(['Patient', 'ServiceRequest', 'ImagingStudy'])
  })

  it('omits ServiceRequest when AccessionNumber is absent', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(minimalHeader({ accessionNumber: undefined }), SETTINGS)
    )
    const types = resources.map((r) => r.resourceType)
    expect(types).toEqual(['Patient', 'ImagingStudy'])
  })

  it('emits no resources when PatientID and PatientName are both absent', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(minimalHeader({ patientId: undefined, patientName: undefined }), SETTINGS)
    )
    expect(resources).toEqual([])
  })

  it('ImagingStudy has basedOn when ServiceRequest is emitted', async () => {
    const resources = await Effect.runPromise(toFhirResources(minimalHeader(), SETTINGS))
    const study = resources.find((r) => r.resourceType === 'ImagingStudy')
    expect(study).toBeDefined()
    if (study?.resourceType !== 'ImagingStudy') return
    expect(study.basedOn.length).toBeGreaterThan(0)
  })

  it('ImagingStudy has no basedOn when ServiceRequest is not emitted', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(minimalHeader({ accessionNumber: undefined }), SETTINGS)
    )
    const study = resources.find((r) => r.resourceType === 'ImagingStudy')
    expect(study).toBeDefined()
    if (study?.resourceType !== 'ImagingStudy') return
    expect(study.basedOn).toEqual([])
  })

  it('ImagingStudy instance carries a gridfsFileId extension when a source file id is given', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(minimalHeader(), SETTINGS, 'doc-ref-id-123')
    )
    const study = resources.find((r) => r.resourceType === 'ImagingStudy')
    expect(study).toBeDefined()
    if (study?.resourceType !== 'ImagingStudy') return
    const instance = study.series[0].instance[0]
    expect(instance.extension).toEqual([
      expect.objectContaining({ url: 'gridfsFileId', valueString: 'doc-ref-id-123' }),
    ])
  })

  it('ImagingStudy instance has no extension when no source file id is given', async () => {
    const resources = await Effect.runPromise(toFhirResources(minimalHeader(), SETTINGS))
    const study = resources.find((r) => r.resourceType === 'ImagingStudy')
    expect(study).toBeDefined()
    if (study?.resourceType !== 'ImagingStudy') return
    const instance = study.series[0].instance[0]
    expect(instance.extension).toEqual([])
  })

  it.each([
    ['M', 'male'],
    ['F', 'female'],
    ['O', 'other'],
  ] as const)('maps gender correctly for %s', async (sex, expected) => {
    const resources = await Effect.runPromise(
      toFhirResources(minimalHeader({ patientSex: sex }), SETTINGS)
    )
    const patient = resources.find((r) => r.resourceType === 'Patient')
    if (patient?.resourceType === 'Patient') {
      expect(patient.gender).toBe(expected)
    }
  })

  it('resolves started against the settings time zone, offset and all', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(minimalHeader({ studyDate: '20240315', studyTime: '143022' }), SETTINGS)
    )
    const study = resources.find((r) => r.resourceType === 'ImagingStudy')
    if (study?.resourceType === 'ImagingStudy') {
      // 14:30:22 in Toronto on Mar 15 is EDT (UTC-4), so 18:30:22Z.
      expect(study.started).toBe('2024-03-15T18:30:22.000Z')
    }
  })

  it('sets started to date-only when StudyTime is absent', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(minimalHeader({ studyTime: undefined }), SETTINGS)
    )
    const study = resources.find((r) => r.resourceType === 'ImagingStudy')
    if (study?.resourceType === 'ImagingStudy') {
      expect(study.started).toBe('2024-03-15')
    }
  })

  it('ServiceRequest code comes from RequestedProcedureDescription', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(
        minimalHeader({ requestedProcedureDescription: 'CT of Chest with Contrast' }),
        SETTINGS
      )
    )
    const sr = resources.find((r) => r.resourceType === 'ServiceRequest')
    if (sr?.resourceType === 'ServiceRequest') {
      expect(sr.code?.text).toBe('CT of Chest with Contrast')
    }
  })

  it('ServiceRequest code falls back to StudyDescription', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(minimalHeader({ requestedProcedureDescription: undefined }), SETTINGS)
    )
    const sr = resources.find((r) => r.resourceType === 'ServiceRequest')
    if (sr?.resourceType === 'ServiceRequest') {
      expect(sr.code?.text).toBe('CT Chest')
    }
  })
})

describe('fhirDate', () => {
  it('formats YYYYMMDD as YYYY-MM-DD', () => {
    expect(fhirDate('20240315')).toBe('2024-03-15')
  })

  it('returns undefined for short strings', () => {
    expect(fhirDate('2024')).toBeUndefined()
  })

  it('returns undefined for undefined', () => {
    expect(fhirDate(undefined)).toBeUndefined()
  })

  it('returns undefined for a date the calendar does not have', () => {
    expect(fhirDate('20240230')).toBeUndefined()
  })
})

describe('fhirDateTime', () => {
  it('resolves date and time against the zone and writes the instant in UTC', () => {
    expect(fhirDateTime('20240315', '143022', 'America/Toronto')).toBe('2024-03-15T18:30:22.000Z')
  })

  it('applies the zone in force on that date, not a fixed offset', () => {
    // Jan 15 is EST (UTC-5) in Toronto; Mar 15 is EDT (UTC-4).
    expect(fhirDateTime('20240115', '143022', 'America/Toronto')).toBe('2024-01-15T19:30:22.000Z')
  })

  it('reads the same wall clock as a different instant in a different zone', () => {
    const toronto = fhirDateTime('20240315', '143022', 'America/Toronto')
    const vancouver = fhirDateTime('20240315', '143022', 'America/Vancouver')
    expect(toronto).not.toBe(vancouver)
  })

  it('returns date-only when time is absent', () => {
    expect(fhirDateTime('20240315', undefined, 'America/Toronto')).toBe('2024-03-15')
  })

  it('returns date-only when time is too short to name a minute', () => {
    expect(fhirDateTime('20240315', '14', 'America/Toronto')).toBe('2024-03-15')
  })

  it('returns date-only when the zone is not a zone', () => {
    expect(fhirDateTime('20240315', '143022', 'Mars/Olympus')).toBe('2024-03-15')
  })

  it('never emits a time without an offset (property)', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('1900-01-01T00:00:00Z'), max: new Date('2099-12-31T00:00:00Z') }),
        fc.constantFrom('America/Toronto', 'America/Vancouver', 'UTC', 'Australia/Eucla'),
        (date, timeZone) => {
          const iso = date.toISOString()
          const da = iso.slice(0, 10).replaceAll('-', '')
          const tm = iso.slice(11, 19).replaceAll(':', '')
          const value = fhirDateTime(da, tm, timeZone)
          expect(value).toBeDefined()
          // FHIR R4 dateTime: a time-of-day obliges a `Z` or a ±HH:MM offset.
          if (value !== undefined && value.includes('T')) {
            expect(/(Z|[+-]\d{2}:\d{2})$/.test(value)).toBe(true)
          }
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
