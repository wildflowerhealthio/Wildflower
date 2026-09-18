import { writeDicom } from 'dicom/test-helpers'
import { Effect, Either } from 'effect'
import { PickedFile, type SourceFile } from 'importer-fundamentals'
import { describe, expect, it } from 'vite-plus/test'

import { decodeDicom } from './decode.ts'
import { type DicomSettings } from './settings.ts'

/**
 * A fixed zone rather than the default, whose `timeZone` is the runtime's own:
 * an assertion on a resolved `started` has to name the zone it was resolved
 * against or it passes only on the machine that wrote it.
 */
const defaultDicomSettings: DicomSettings = { timeZone: 'America/Toronto' }

/** A local pick of the given bytes — what the picker hands every decode. */
const pick = (bytes: Uint8Array): PickedFile.Type => ({
  fileName: 'sample.dcm',
  bytes,
  source: PickedFile.Source.local,
})

/**
 * The source file the importer resolves before calling this decode; the
 * decode reads its id and recomputes nothing, so a stand-in id is enough.
 */
const source: SourceFile.Reference = 'DocumentReference/doc-1'

const sampleDicomBytes = (): Uint8Array =>
  writeDicom({
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
  })

describe('decodeDicom', () => {
  it('resolves ImagingStudy.started against the settings time zone', async () => {
    const result = await Effect.runPromise(
      decodeDicom(pick(sampleDicomBytes()), defaultDicomSettings, source)
    )
    const study = result.sections[0].resources.find((r) => r.key === 'imaging-study')?.resource
    expect(study?.resourceType).toBe('ImagingStudy')
    if (study?.resourceType !== 'ImagingStudy') return
    // StudyTime 14:30:22 in Toronto on Mar 15 is EDT (UTC-4).
    expect(study.started).toBe('2024-03-15T18:30:22.000Z')
  })

  it('reads the same file as a different instant under a different zone', async () => {
    const startedIn = async (timeZone: string): Promise<string | null | undefined> => {
      const result = await Effect.runPromise(
        decodeDicom(pick(sampleDicomBytes()), { timeZone }, source)
      )
      const study = result.sections[0].resources.find((r) => r.key === 'imaging-study')?.resource
      return study?.resourceType === 'ImagingStudy' ? study.started : undefined
    }
    expect(await startedIn('America/Toronto')).not.toBe(await startedIn('America/Vancouver'))
  })

  it('fails rather than guessing when the settings time zone is not a zone', async () => {
    const result = await Effect.runPromise(
      Effect.either(decodeDicom(pick(sampleDicomBytes()), { timeZone: 'Mars/Olympus' }, source))
    )
    expect(Either.isLeft(result)).toBe(true)
  })

  it('yields one section with Patient, ServiceRequest, ImagingStudy', async () => {
    const result = await Effect.runPromise(
      decodeDicom(pick(sampleDicomBytes()), defaultDicomSettings, source)
    )
    expect(result.sections).toHaveLength(1)
    const keys = result.sections[0].resources.map((r) => r.key)
    expect(keys).toEqual(['patient', 'service-request', 'imaging-study'])
  })

  it('ImagingStudy instance carries the resolved source file id as its gridfsFileId', async () => {
    const result = await Effect.runPromise(
      decodeDicom(pick(sampleDicomBytes()), defaultDicomSettings, source)
    )

    const studyEntry = result.sections[0].resources.find((r) => r.key === 'imaging-study')
    const study = studyEntry?.resource
    if (study?.resourceType !== 'ImagingStudy') throw new Error('expected ImagingStudy')
    const instance = study.series[0].instance[0]
    expect(instance.extension).toEqual([
      expect.objectContaining({ url: 'gridfsFileId', valueString: 'doc-1' }),
    ])
  })

  it('section title includes modality, description, and date', async () => {
    const result = await Effect.runPromise(
      decodeDicom(pick(sampleDicomBytes()), defaultDicomSettings, source)
    )
    expect(result.sections[0].title).toBe('CT Chest CT · 2024-03-15')
  })

  it('notes no ServiceRequest when AccessionNumber is absent', async () => {
    const bytes = writeDicom({
      StudyInstanceUID: '1.2.3.4.5',
      SeriesInstanceUID: '1.2.3.4.5.1',
      SOPInstanceUID: '1.2.3.4.5.1.1',
      PatientName: { family: 'Doe', given: 'John', text: 'Doe John' },
      PatientID: 'P001',
      Modality: 'CT',
    })
    const result = await Effect.runPromise(decodeDicom(pick(bytes), defaultDicomSettings, source))
    expect(result.notes.some((n) => n.includes('AccessionNumber'))).toBe(true)
    const keys = result.sections[0].resources.map((r) => r.key)
    expect(keys).not.toContain('service-request')
  })

  it('yields zero sections and a note when no patient identity', async () => {
    const bytes = writeDicom({
      StudyInstanceUID: '1.2.3.4.5',
      SeriesInstanceUID: '1.2.3.4.5.1',
      SOPInstanceUID: '1.2.3.4.5.1.1',
      Modality: 'CT',
    })
    const result = await Effect.runPromise(decodeDicom(pick(bytes), defaultDicomSettings, source))
    expect(result.sections).toEqual([])
    expect(result.notes.some((n) => n.includes('patient identity'))).toBe(true)
  })

  it('treats a delimiters-only PatientName as no patient identity', async () => {
    // What a writer emits for an anonymized name. It is not a name with empty
    // parts: synthesizing one would write `name: [{ text: '' }]` (FHIR `string`
    // forbids an empty value) and derive the same Patient id for every such
    // file, collapsing unrelated studies onto one patient.
    const bytes = writeDicom({
      StudyInstanceUID: '1.2.3.4.5',
      SeriesInstanceUID: '1.2.3.4.5.1',
      SOPInstanceUID: '1.2.3.4.5.1.1',
      PatientName: { family: '', given: '', text: '^^^' },
      Modality: 'CT',
    })
    const result = await Effect.runPromise(decodeDicom(pick(bytes), defaultDicomSettings, source))
    expect(result.sections).toEqual([])
    expect(result.notes.some((n) => n.includes('patient identity'))).toBe(true)
  })

  it('fails with ParseError on truncated bytes', async () => {
    const result = Effect.runSync(
      Effect.either(
        decodeDicom(pick(new Uint8Array([0x00, 0x01, 0x02])), defaultDicomSettings, source)
      )
    )
    expect(result._tag).toBe('Left')
  })

  it('resource keys are stable across the empty settings', async () => {
    const result1 = await Effect.runPromise(
      decodeDicom(pick(sampleDicomBytes()), defaultDicomSettings, source)
    )
    const result2 = await Effect.runPromise(
      decodeDicom(pick(sampleDicomBytes()), defaultDicomSettings, source)
    )
    const keys1 = result1.sections.flatMap((s) => s.resources.map((r) => r.key))
    const keys2 = result2.sections.flatMap((s) => s.resources.map((r) => r.key))
    expect(keys1).toEqual(keys2)
  })
})

describe('sectionTitle', () => {
  it('falls back to "DICOM study" when modality and description are absent', async () => {
    const bytes = writeDicom({
      StudyInstanceUID: '1.2.3.4.5',
      SeriesInstanceUID: '1.2.3.4.5.1',
      SOPInstanceUID: '1.2.3.4.5.1.1',
      PatientID: 'P001',
    })
    const result = await Effect.runPromise(decodeDicom(pick(bytes), defaultDicomSettings, source))
    expect(result.sections[0].title).toBe('DICOM study')
  })

  it('includes modality and date when available', async () => {
    const bytes = writeDicom({
      StudyInstanceUID: '1.2.3.4.5',
      SeriesInstanceUID: '1.2.3.4.5.1',
      SOPInstanceUID: '1.2.3.4.5.1.1',
      PatientID: 'P001',
      Modality: 'MR',
      StudyDate: '20240101',
    })
    const result = await Effect.runPromise(decodeDicom(pick(bytes), defaultDicomSettings, source))
    expect(result.sections[0].title).toBe('MR · 2024-01-01')
  })
})
