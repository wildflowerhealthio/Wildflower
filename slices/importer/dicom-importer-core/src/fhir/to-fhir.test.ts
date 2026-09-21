import type { DicomHeader } from 'dicom'
import { dicomHeaderArb } from 'dicom/test-helpers'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import type { ImagingStudy } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { DicomSettings } from '../settings.ts'
import {
  accessionNumbers,
  fhirDate,
  fhirDateTime,
  orderedInstances,
  patientOriginalId,
  studySeries,
  toFhirResources,
  type StudyInstance,
} from './to-fhir.ts'

/**
 * A fixed zone rather than `defaultDicomSettings`, whose `timeZone` is the
 * runtime's own — an assertion on a resolved instant has to name the zone it
 * was resolved against or it passes only on the machine that wrote it.
 * `America/Toronto` observes DST, so it also exercises the offset actually
 * changing across the year.
 */
const SETTINGS: DicomSettings = { timeZone: 'America/Toronto' }

const minimalHeader = (overrides: Partial<DicomHeader.Type> = {}): DicomHeader.Type => ({
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
  // The Image Pixel module describes how the frames are encoded; nothing in
  // the FHIR synthesis reads it, so the minimal header leaves it absent.
  samplesPerPixel: undefined,
  photometricInterpretation: undefined,
  planarConfiguration: undefined,
  bitsAllocated: undefined,
  bitsStored: undefined,
  highBit: undefined,
  pixelRepresentation: undefined,
  rescaleIntercept: undefined,
  rescaleSlope: undefined,
  windowCenter: undefined,
  windowWidth: undefined,
  pixelData: undefined,
  manufacturer: 'GE MEDICAL SYSTEMS',
  manufacturerModelName: 'Discovery',
  institutionName: 'Test Hospital',
  parserWarnings: [],
  ...overrides,
})

/**
 * One file's header as the file set the synthesis takes. Most of these cases are
 * about one header's tags, which a one-instance study states exactly as a
 * single file used to; the study-level cases below build sets of several.
 */
const oneFileStudy = (
  header: DicomHeader.Type,
  sourceFileId?: string
): readonly StudyInstance[] => [{ header, sourceFileId }]

describe('toFhirResources', () => {
  it('produces deterministic ids from the same tags (property)', () => {
    fc.assert(
      fc.property(
        dicomHeaderArb().filter((h) => patientOriginalId(h) !== undefined),
        (header) => {
          const run1 = Effect.runSync(toFhirResources(oneFileStudy(header), SETTINGS))
          const run2 = Effect.runSync(toFhirResources(oneFileStudy(header), SETTINGS))
          expect(run1.map((r) => r.id)).toEqual(run2.map((r) => r.id))
        }
      ),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('emits Patient, ServiceRequest, ImagingStudy when AccessionNumber is present', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(oneFileStudy(minimalHeader()), SETTINGS)
    )
    const types = resources.map((r) => r.resourceType)
    expect(types).toEqual(['Patient', 'ServiceRequest', 'ImagingStudy'])
  })

  it('omits ServiceRequest when AccessionNumber is absent', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(oneFileStudy(minimalHeader({ accessionNumber: undefined })), SETTINGS)
    )
    const types = resources.map((r) => r.resourceType)
    expect(types).toEqual(['Patient', 'ImagingStudy'])
  })

  it('emits no resources when PatientID and PatientName are both absent', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(
        oneFileStudy(minimalHeader({ patientId: undefined, patientName: undefined })),
        SETTINGS
      )
    )
    expect(resources).toEqual([])
  })

  it('ImagingStudy has basedOn when ServiceRequest is emitted', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(oneFileStudy(minimalHeader()), SETTINGS)
    )
    const study = resources.find((r) => r.resourceType === 'ImagingStudy')
    expect(study).toBeDefined()
    if (study?.resourceType !== 'ImagingStudy') return
    expect(study.basedOn.length).toBeGreaterThan(0)
  })

  it('ImagingStudy has no basedOn when ServiceRequest is not emitted', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(oneFileStudy(minimalHeader({ accessionNumber: undefined })), SETTINGS)
    )
    const study = resources.find((r) => r.resourceType === 'ImagingStudy')
    expect(study).toBeDefined()
    if (study?.resourceType !== 'ImagingStudy') return
    expect(study.basedOn).toEqual([])
  })

  it('ImagingStudy instance carries a gridfsFileId extension when a source file id is given', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(oneFileStudy(minimalHeader(), 'doc-ref-id-123'), SETTINGS)
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
    const resources = await Effect.runPromise(
      toFhirResources(oneFileStudy(minimalHeader()), SETTINGS)
    )
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
      toFhirResources(oneFileStudy(minimalHeader({ patientSex: sex })), SETTINGS)
    )
    const patient = resources.find((r) => r.resourceType === 'Patient')
    if (patient?.resourceType === 'Patient') {
      expect(patient.gender).toBe(expected)
    }
  })

  it('resolves started against the settings time zone, offset and all', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(
        oneFileStudy(minimalHeader({ studyDate: '20240315', studyTime: '143022' })),
        SETTINGS
      )
    )
    const study = resources.find((r) => r.resourceType === 'ImagingStudy')
    if (study?.resourceType === 'ImagingStudy') {
      // 14:30:22 in Toronto on Mar 15 is EDT (UTC-4), so 18:30:22Z.
      expect(study.started).toBe('2024-03-15T18:30:22.000Z')
    }
  })

  it('sets started to date-only when StudyTime is absent', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(oneFileStudy(minimalHeader({ studyTime: undefined })), SETTINGS)
    )
    const study = resources.find((r) => r.resourceType === 'ImagingStudy')
    if (study?.resourceType === 'ImagingStudy') {
      expect(study.started).toBe('2024-03-15')
    }
  })

  it('ServiceRequest code comes from RequestedProcedureDescription', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(
        oneFileStudy(minimalHeader({ requestedProcedureDescription: 'CT of Chest with Contrast' })),
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
      toFhirResources(
        oneFileStudy(minimalHeader({ requestedProcedureDescription: undefined })),
        SETTINGS
      )
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

/**
 * A study spread across files: the same study and patient in every header,
 * differing only in what a file legitimately differs in.
 */
const instanceOf = (
  overrides: Partial<DicomHeader.Type>,
  sourceFileId?: string
): StudyInstance => ({ header: minimalHeader(overrides), sourceFileId })

describe('toFhirResources over a study of several files', () => {
  const twoSeries: readonly StudyInstance[] = [
    instanceOf(
      { seriesInstanceUid: 'S2', seriesNumber: 2, sopInstanceUid: 'I3', instanceNumber: 1 },
      'doc-3'
    ),
    instanceOf(
      { seriesInstanceUid: 'S1', seriesNumber: 1, sopInstanceUid: 'I2', instanceNumber: 2 },
      'doc-2'
    ),
    instanceOf(
      { seriesInstanceUid: 'S1', seriesNumber: 1, sopInstanceUid: 'I1', instanceNumber: 1 },
      'doc-1'
    ),
  ]

  const studyOf = async (
    instances: readonly StudyInstance[]
  ): Promise<typeof ImagingStudy.Schema.Type> => {
    const resources = await Effect.runPromise(toFhirResources(instances, SETTINGS))
    const study = resources.find((r) => r.resourceType === 'ImagingStudy')
    if (study?.resourceType !== 'ImagingStudy') throw new Error('expected one ImagingStudy')
    return study
  }

  it('yields one ImagingStudy whose counts are the real ones', async () => {
    const resources = await Effect.runPromise(toFhirResources(twoSeries, SETTINGS))
    expect(resources.filter((r) => r.resourceType === 'ImagingStudy')).toHaveLength(1)
    expect(resources.filter((r) => r.resourceType === 'Patient')).toHaveLength(1)
    const study = await studyOf(twoSeries)
    expect(study.numberOfSeries).toBe(2)
    expect(study.numberOfInstances).toBe(3)
  })

  it('groups instances by SeriesInstanceUID, ordered by number', async () => {
    const study = await studyOf(twoSeries)
    expect(study.series.map((one) => one.uid)).toEqual(['S1', 'S2'])
    expect(study.series[0].instance.map((one) => one.uid)).toEqual(['I1', 'I2'])
    expect(study.series[1].instance.map((one) => one.uid)).toEqual(['I3'])
  })

  it('gives each instance the gridfsFileId of its own file', async () => {
    const study = await studyOf(twoSeries)
    const extensionsByUid = study.series.flatMap((series) =>
      series.instance.map((instance) => [instance.uid, instance.extension[0]?.valueString])
    )
    expect(extensionsByUid).toEqual([
      ['I1', 'doc-1'],
      ['I2', 'doc-2'],
      ['I3', 'doc-3'],
    ])
  })

  it('carries every distinct modality of the study', async () => {
    const study = await studyOf([
      instanceOf({
        seriesInstanceUid: 'S1',
        seriesNumber: 1,
        sopInstanceUid: 'I1',
        modality: 'CT',
      }),
      instanceOf({
        seriesInstanceUid: 'S2',
        seriesNumber: 2,
        sopInstanceUid: 'I2',
        modality: 'PT',
      }),
      instanceOf({
        seriesInstanceUid: 'S3',
        seriesNumber: 3,
        sopInstanceUid: 'I3',
        modality: 'CT',
      }),
    ])
    expect(study.modality.map((one) => one.code)).toEqual(['CT', 'PT'])
  })

  it('starts at the earliest acquisition the study states', async () => {
    const study = await studyOf([
      instanceOf({
        sopInstanceUid: 'I1',
        instanceNumber: 1,
        studyDate: '20240315',
        studyTime: '143022',
      }),
      instanceOf({
        sopInstanceUid: 'I2',
        instanceNumber: 2,
        studyDate: '20240315',
        studyTime: '090000',
      }),
    ])
    // 09:00:22-less — 09:00 in Toronto on Mar 15 is EDT (UTC-4).
    expect(study.started).toBe('2024-03-15T13:00:00.000Z')
  })

  it('synthesizes identical resources whatever order the files were picked in', async () => {
    const forward = await Effect.runPromise(toFhirResources(twoSeries, SETTINGS))
    const reversed = await Effect.runPromise(toFhirResources(twoSeries.toReversed(), SETTINGS))
    expect(reversed).toEqual(forward)
  })

  it('is order-independent for any shuffling of a generated study (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: 6 }), { minLength: 2, maxLength: 6 }),
        async (instanceNumbers) => {
          const instances = instanceNumbers.map((number) =>
            instanceOf(
              {
                seriesInstanceUid: `S${number % 2}`,
                seriesNumber: number % 2,
                sopInstanceUid: `I${number}`,
                instanceNumber: number,
              },
              `doc-${number}`
            )
          )
          const one = await Effect.runPromise(toFhirResources(instances, SETTINGS))
          const other = await Effect.runPromise(toFhirResources(instances.toReversed(), SETTINGS))
          expect(other).toEqual(one)
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('builds one ServiceRequest from the first accession when files disagree', async () => {
    const instances = [
      instanceOf({ sopInstanceUid: 'I1', instanceNumber: 1, accessionNumber: 'ACC-A' }),
      instanceOf({ sopInstanceUid: 'I2', instanceNumber: 2, accessionNumber: 'ACC-B' }),
    ]
    expect(accessionNumbers(instances)).toEqual(['ACC-A', 'ACC-B'])
    const resources = await Effect.runPromise(toFhirResources(instances, SETTINGS))
    const requests = resources.filter((r) => r.resourceType === 'ServiceRequest')
    expect(requests).toHaveLength(1)
    expect(requests[0].identifier.map((one) => one.value)).toEqual(['ACC-A'])
  })

  it('emits a ServiceRequest when only a later file states the accession', async () => {
    const resources = await Effect.runPromise(
      toFhirResources(
        [
          instanceOf({ sopInstanceUid: 'I1', instanceNumber: 1, accessionNumber: undefined }),
          instanceOf({ sopInstanceUid: 'I2', instanceNumber: 2, accessionNumber: 'ACC-B' }),
        ],
        SETTINGS
      )
    )
    expect(resources.map((r) => r.resourceType)).toEqual([
      'Patient',
      'ServiceRequest',
      'ImagingStudy',
    ])
  })
})

describe('studySeries', () => {
  it('sorts a series with no SeriesNumber after every numbered one', () => {
    const ordered = studySeries([
      instanceOf({ seriesInstanceUid: 'A', seriesNumber: undefined, sopInstanceUid: 'I1' }),
      instanceOf({ seriesInstanceUid: 'B', seriesNumber: 9, sopInstanceUid: 'I2' }),
    ])
    expect(ordered.map((one) => one.uid)).toEqual(['B', 'A'])
  })

  it('keeps every instance, including two files sharing a SOPInstanceUID', () => {
    const instances = [
      instanceOf({ sopInstanceUid: 'I1', instanceNumber: 1 }, 'doc-b'),
      instanceOf({ sopInstanceUid: 'I1', instanceNumber: 1 }, 'doc-a'),
    ]
    expect(orderedInstances(instances).map((one) => one.sourceFileId)).toEqual(['doc-a', 'doc-b'])
  })
})
