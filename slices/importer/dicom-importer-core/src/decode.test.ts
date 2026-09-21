import { DicomHeader } from 'dicom'
import { writeDicom, type DicomTagMap } from 'dicom/test-helpers'
import { Effect, Either } from 'effect'
import { PickedFile } from 'importer-fundamentals'
import { describe, expect, it } from 'vite-plus/test'

import { decodeStudy, type StudyFile } from './decode.ts'
import { type DicomSettings } from './settings.ts'

/**
 * A fixed zone rather than the default, whose `timeZone` is the runtime's own:
 * an assertion on a resolved `started` has to name the zone it was resolved
 * against or it passes only on the machine that wrote it.
 */
const defaultDicomSettings: DicomSettings = { timeZone: 'America/Toronto' }

/**
 * One file of a study, parsed — what the decode function hands this decode
 * once it has partitioned the pick and minted the archives.
 */
const studyFile = (
  tags: DicomTagMap,
  { fileName = 'sample.dcm', sourceFileId = 'doc-1' } = {}
): StudyFile => {
  const bytes = writeDicom(tags)
  const parsed = DicomHeader.tryFromDicomFile(bytes)
  if (Either.isLeft(parsed)) throw new Error(parsed.left.reason)
  return {
    file: { fileName, bytes, source: PickedFile.Source.local },
    header: parsed.right,
    sourceFileId,
  }
}

const SAMPLE_TAGS: DicomTagMap = {
  StudyInstanceUID: '1.2.3.4.5',
  SeriesInstanceUID: '1.2.3.4.5.1',
  SOPInstanceUID: '1.2.3.4.5.1.1',
  PatientName: { family: 'Doe', given: 'John', text: 'Doe John' },
  PatientID: 'P001',
  Modality: 'CT',
  StudyDescription: 'Chest CT',
  StudyDate: '20240315',
  StudyTime: '143022',
  AccessionNumber: 'ACC001',
}

const sample = (overrides: DicomTagMap = {}): readonly StudyFile[] => [
  studyFile({ ...SAMPLE_TAGS, ...overrides }),
]

describe('decodeStudy', () => {
  it('resolves ImagingStudy.started against the settings time zone', async () => {
    const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))
    const study = result.sections[0].resources.find((r) => r.key === 'imaging-study')?.resource
    expect(study?.resourceType).toBe('ImagingStudy')
    if (study?.resourceType !== 'ImagingStudy') return
    // StudyTime 14:30:22 in Toronto on Mar 15 is EDT (UTC-4).
    expect(study.started).toBe('2024-03-15T18:30:22.000Z')
  })

  it('reads the same file as a different instant under a different zone', async () => {
    const startedIn = async (timeZone: string): Promise<string | null | undefined> => {
      const result = await Effect.runPromise(decodeStudy(sample(), { timeZone }))
      const study = result.sections[0].resources.find((r) => r.key === 'imaging-study')?.resource
      return study?.resourceType === 'ImagingStudy' ? study.started : undefined
    }
    expect(await startedIn('America/Toronto')).not.toBe(await startedIn('America/Vancouver'))
  })

  it('yields one section with Patient, ServiceRequest, ImagingStudy', async () => {
    const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))
    expect(result.sections).toHaveLength(1)
    const keys = result.sections[0].resources.map((r) => r.key)
    expect(keys).toEqual(['patient', 'service-request', 'imaging-study'])
  })

  it('ImagingStudy instance carries its own file id as its gridfsFileId', async () => {
    const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))

    const studyEntry = result.sections[0].resources.find((r) => r.key === 'imaging-study')
    const study = studyEntry?.resource
    if (study?.resourceType !== 'ImagingStudy') throw new Error('expected ImagingStudy')
    const instance = study.series[0].instance[0]
    expect(instance.extension).toEqual([
      expect.objectContaining({ url: 'gridfsFileId', valueString: 'doc-1' }),
    ])
  })

  it('section title includes modality, description, and date', async () => {
    const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))
    expect(result.sections[0].title).toBe('CT Chest CT · 2024-03-15')
  })

  it('notes no ServiceRequest when AccessionNumber is absent', async () => {
    const result = await Effect.runPromise(
      decodeStudy(sample({ AccessionNumber: undefined }), defaultDicomSettings)
    )
    expect(result.notes.some((n) => n.includes('AccessionNumber'))).toBe(true)
    const keys = result.sections[0].resources.map((r) => r.key)
    expect(keys).not.toContain('service-request')
  })

  it('yields zero sections and a note when no patient identity', async () => {
    const result = await Effect.runPromise(
      decodeStudy(
        sample({ PatientID: undefined, PatientName: undefined, AccessionNumber: undefined }),
        defaultDicomSettings
      )
    )
    expect(result.sections).toEqual([])
    expect(result.notes.some((n) => n.includes('patient identity'))).toBe(true)
  })

  it('treats a delimiters-only PatientName as no patient identity', async () => {
    // What a writer emits for an anonymized name. It is not a name with empty
    // parts: synthesizing one would write `name: [{ text: '' }]` (FHIR `string`
    // forbids an empty value) and derive the same Patient id for every such
    // file, collapsing unrelated studies onto one patient.
    const result = await Effect.runPromise(
      decodeStudy(
        sample({ PatientID: undefined, PatientName: { family: '', given: '', text: '^^^' } }),
        defaultDicomSettings
      )
    )
    expect(result.sections).toEqual([])
    expect(result.notes.some((n) => n.includes('patient identity'))).toBe(true)
  })

  it('resource keys are stable across the empty settings', async () => {
    const keysOf = async (): Promise<readonly string[]> => {
      const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))
      return result.sections.flatMap((s) => s.resources.map((r) => r.key))
    }
    expect(await keysOf()).toEqual(await keysOf())
  })

  describe('a study spread across files', () => {
    const twoFiles: readonly StudyFile[] = [
      studyFile(
        { ...SAMPLE_TAGS, SeriesInstanceUID: '1.2.3.4.5.2', SeriesNumber: 2, SOPInstanceUID: 'I2' },
        { fileName: 'b.dcm', sourceFileId: 'doc-b' }
      ),
      studyFile(
        { ...SAMPLE_TAGS, SeriesInstanceUID: '1.2.3.4.5.1', SeriesNumber: 1, SOPInstanceUID: 'I1' },
        { fileName: 'a.dcm', sourceFileId: 'doc-a' }
      ),
    ]

    it('is still one section with the same three keys', async () => {
      const result = await Effect.runPromise(decodeStudy(twoFiles, defaultDicomSettings))
      expect(result.sections).toHaveLength(1)
      expect(result.sections[0].resources.map((r) => r.key)).toEqual([
        'patient',
        'service-request',
        'imaging-study',
      ])
    })

    it('notes what each file contributed, in study order', async () => {
      const result = await Effect.runPromise(decodeStudy(twoFiles, defaultDicomSettings))
      expect(result.notes).toEqual([
        'a.dcm: series 1, instance I1.',
        'b.dcm: series 2, instance I2.',
      ])
    })

    it('notes an AccessionNumber the files disagree on, and does not merge them', async () => {
      const conflicting: readonly StudyFile[] = [
        twoFiles[0],
        studyFile(
          {
            ...SAMPLE_TAGS,
            SeriesInstanceUID: '1.2.3.4.5.1',
            SeriesNumber: 1,
            SOPInstanceUID: 'I1',
            AccessionNumber: 'ACC002',
          },
          { fileName: 'a.dcm', sourceFileId: 'doc-a' }
        ),
      ]
      const result = await Effect.runPromise(decodeStudy(conflicting, defaultDicomSettings))
      expect(result.notes[0]).toContain('disagree on AccessionNumber')
      const request = result.sections[0].resources.find(
        (r) => r.key === 'service-request'
      )?.resource
      if (request?.resourceType !== 'ServiceRequest') throw new Error('expected a ServiceRequest')
      // One request, built from the first accession in *study* order — a.dcm
      // is series 1 — with the other nowhere on it: the two are not merged.
      const values = request.identifier.map((one) => one.value)
      expect(values).toContain('ACC002')
      expect(values).not.toContain('ACC001')
    })

    it('says nothing per file when the study is one file', async () => {
      const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))
      expect(result.notes).toEqual([])
    })
  })
})

describe('sectionTitle', () => {
  it('falls back to "DICOM study" when modality and description are absent', async () => {
    const result = await Effect.runPromise(
      decodeStudy(
        sample({
          Modality: undefined,
          StudyDescription: undefined,
          StudyDate: undefined,
          StudyTime: undefined,
        }),
        defaultDicomSettings
      )
    )
    expect(result.sections[0].title).toBe('DICOM study')
  })

  it('includes modality and date when available', async () => {
    const result = await Effect.runPromise(
      decodeStudy(
        sample({ Modality: 'MR', StudyDescription: undefined, StudyDate: '20240101' }),
        defaultDicomSettings
      )
    )
    expect(result.sections[0].title).toBe('MR · 2024-01-01')
  })
})
