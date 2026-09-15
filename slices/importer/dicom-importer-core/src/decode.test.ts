import { writeDicom } from 'dicom/test-helpers'
import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { decodeDicom } from './decode.ts'
import { defaultDicomSettings } from './settings.ts'
import { buildSourceFile } from './source-file/index.ts'

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
  it('yields one section with Patient, ServiceRequest, ImagingStudy', async () => {
    const result = await Effect.runPromise(
      decodeDicom(sampleDicomBytes(), 'sample.dcm', defaultDicomSettings)
    )
    expect(result.sections).toHaveLength(1)
    const keys = result.sections[0].resources.map((r) => r.key)
    expect(keys).toEqual(['patient', 'service-request', 'imaging-study'])
  })

  it('ImagingStudy instance carries the gridfsFileId extension matching the source file id', async () => {
    const bytes = sampleDicomBytes()
    const result = await Effect.runPromise(decodeDicom(bytes, 'sample.dcm', defaultDicomSettings))
    const sourceFile = await Effect.runPromise(buildSourceFile({ fileName: 'sample.dcm', bytes }))

    const studyEntry = result.sections[0].resources.find((r) => r.key === 'imaging-study')
    const study = studyEntry?.resource
    if (study?.resourceType !== 'ImagingStudy') throw new Error('expected ImagingStudy')
    const instance = study.series[0].instance[0]
    expect(instance.extension).toEqual([
      expect.objectContaining({ url: 'gridfsFileId', valueString: sourceFile.id }),
    ])
  })

  it('section title includes modality, description, and date', async () => {
    const result = await Effect.runPromise(
      decodeDicom(sampleDicomBytes(), 'sample.dcm', defaultDicomSettings)
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
    const result = await Effect.runPromise(decodeDicom(bytes, 'sample.dcm', defaultDicomSettings))
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
    const result = await Effect.runPromise(decodeDicom(bytes, 'sample.dcm', defaultDicomSettings))
    expect(result.sections).toEqual([])
    expect(result.notes.some((n) => n.includes('patient identity'))).toBe(true)
  })

  it('fails with ParseError on truncated bytes', async () => {
    const result = Effect.runSync(
      Effect.either(
        decodeDicom(new Uint8Array([0x00, 0x01, 0x02]), 'sample.dcm', defaultDicomSettings)
      )
    )
    expect(result._tag).toBe('Left')
  })

  it('resource keys are stable across the empty settings', async () => {
    const result1 = await Effect.runPromise(
      decodeDicom(sampleDicomBytes(), 'sample.dcm', defaultDicomSettings)
    )
    const result2 = await Effect.runPromise(
      decodeDicom(sampleDicomBytes(), 'sample.dcm', defaultDicomSettings)
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
    const result = await Effect.runPromise(decodeDicom(bytes, 'sample.dcm', defaultDicomSettings))
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
    const result = await Effect.runPromise(decodeDicom(bytes, 'sample.dcm', defaultDicomSettings))
    expect(result.sections[0].title).toBe('MR · 2024-01-01')
  })
})
