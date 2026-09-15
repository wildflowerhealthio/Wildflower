import type { DicomHeader } from 'dicom'
import { dicomHeaderArb } from 'dicom/test-helpers'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { fhirDate, fhirDateTime, patientOriginalId, toFhirResources } from './to-fhir.ts'

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
          const run1 = Effect.runSync(toFhirResources(header))
          const run2 = Effect.runSync(toFhirResources(header))
          expect(run1.map((r) => r.id)).toEqual(run2.map((r) => r.id))
        }
      ),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('emits Patient, ServiceRequest, ImagingStudy when AccessionNumber is present', async () => {
    const resources = await Effect.runPromise(toFhirResources(minimalHeader()))
    const types = resources.map((r) => r.resourceType)
    expect(types).toEqual(['Patient', 'ServiceRequest', 'ImagingStudy'])
  })

  it('omits ServiceRequest when AccessionNumber is absent', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(minimalHeader({ accessionNumber: undefined }))
    )
    const types = resources.map((r) => r.resourceType)
    expect(types).toEqual(['Patient', 'ImagingStudy'])
  })

  it('emits no resources when PatientID and PatientName are both absent', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(minimalHeader({ patientId: undefined, patientName: undefined }))
    )
    expect(resources).toEqual([])
  })

  it('ImagingStudy has basedOn when ServiceRequest is emitted', async () => {
    const resources = await Effect.runPromise(toFhirResources(minimalHeader()))
    const study = resources.find((r) => r.resourceType === 'ImagingStudy')
    expect(study).toBeDefined()
    if (study?.resourceType !== 'ImagingStudy') return
    expect(study.basedOn.length).toBeGreaterThan(0)
  })

  it('ImagingStudy has no basedOn when ServiceRequest is not emitted', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(minimalHeader({ accessionNumber: undefined }))
    )
    const study = resources.find((r) => r.resourceType === 'ImagingStudy')
    expect(study).toBeDefined()
    if (study?.resourceType !== 'ImagingStudy') return
    expect(study.basedOn).toEqual([])
  })

  it('maps gender correctly', async () => {
    for (const [sex, expected] of [
      ['M', 'male'],
      ['F', 'female'],
      ['O', 'other'],
    ] as const) {
      const resources = await Effect.runPromise(toFhirResources(minimalHeader({ patientSex: sex })))
      const patient = resources.find((r) => r.resourceType === 'Patient')
      if (patient?.resourceType === 'Patient') {
        expect(patient.gender).toBe(expected)
      }
    }
  })

  it('composes started from StudyDate + StudyTime', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(minimalHeader({ studyDate: '20240315', studyTime: '143022' }))
    )
    const study = resources.find((r) => r.resourceType === 'ImagingStudy')
    if (study?.resourceType === 'ImagingStudy') {
      expect(study.started).toBe('2024-03-15T14:30:22')
    }
  })

  it('sets started to date-only when StudyTime is absent', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(minimalHeader({ studyTime: undefined }))
    )
    const study = resources.find((r) => r.resourceType === 'ImagingStudy')
    if (study?.resourceType === 'ImagingStudy') {
      expect(study.started).toBe('2024-03-15')
    }
  })

  it('ServiceRequest code comes from RequestedProcedureDescription', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(minimalHeader({ requestedProcedureDescription: 'CT of Chest with Contrast' }))
    )
    const sr = resources.find((r) => r.resourceType === 'ServiceRequest')
    if (sr?.resourceType === 'ServiceRequest') {
      expect(sr.code?.text).toBe('CT of Chest with Contrast')
    }
  })

  it('ServiceRequest code falls back to StudyDescription', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(minimalHeader({ requestedProcedureDescription: undefined }))
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
})

describe('fhirDateTime', () => {
  it('composes date and time', () => {
    expect(fhirDateTime('20240315', '143022')).toBe('2024-03-15T14:30:22')
  })

  it('returns date-only when time is absent', () => {
    expect(fhirDateTime('20240315', undefined)).toBe('2024-03-15')
  })

  it('returns date-only when time is too short', () => {
    expect(fhirDateTime('20240315', '14')).toBe('2024-03-15')
  })
})
