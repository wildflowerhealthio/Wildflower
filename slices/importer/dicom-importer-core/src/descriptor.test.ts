import { parseDicomFile } from 'dicom'
import { writeDicom } from 'dicom/test-helpers'
import { DateTime, Effect, Either, Option } from 'effect'
import { localResourceId } from 'fhir-r4/identity'
import { describe, expect, it } from 'vite-plus/test'

import { dicomImporterDescriptor } from './descriptor.ts'
import { patientOriginalId } from './fhir/to-fhir.ts'
import { defaultDicomSettings } from './settings.ts'
import { DICOM_SYSTEM } from './source-system.ts'

const sampleDicomBytes = (): Uint8Array =>
  writeDicom({
    StudyInstanceUID: '1.2.3.4.5',
    SeriesInstanceUID: '1.2.3.4.5.1',
    SOPInstanceUID: '1.2.3.4.5.1.1',
    PatientName: { family: 'Doe', given: 'John', text: 'Doe John' },
    PatientID: 'P001',
    Modality: 'CT',
  })

describe('dicomImporterDescriptor', () => {
  it('has the dicom format tag', () => {
    expect(dicomImporterDescriptor.format).toBe('dicom')
  })

  it('detects a file with DICM magic bytes at offset 128', () => {
    const bytes = new Uint8Array(132)
    bytes.set([0x44, 0x49, 0x43, 0x4d], 128)
    expect(dicomImporterDescriptor.detect(bytes, 'unknown')).toBe(true)
  })

  it('detects a file by .dcm extension', () => {
    expect(dicomImporterDescriptor.detect(new Uint8Array(), 'scan.dcm')).toBe(true)
    expect(dicomImporterDescriptor.detect(new Uint8Array(), 'Scan.DCM')).toBe(true)
  })

  it('does not claim a non-DICOM file', () => {
    const json = new TextEncoder().encode('{"log":{"version":"1.2"}}')
    expect(dicomImporterDescriptor.detect(json, 'capture.har')).toBe(false)
  })

  it('defaultSettings carries a time zone the runtime can resolve', () => {
    expect(dicomImporterDescriptor.defaultSettings).toEqual(defaultDicomSettings)
    expect(Object.keys(dicomImporterDescriptor.defaultSettings)).toEqual(['timeZone'])
    expect(Option.isSome(DateTime.zoneMakeNamed(defaultDicomSettings.timeZone))).toBe(true)
  })

  describe('buildSourceFile', () => {
    it('derives the archive subject from the DICOM header when the caller passes none', async () => {
      const bytes = sampleDicomBytes()
      const sourceFile = await Effect.runPromise(
        dicomImporterDescriptor.buildSourceFile({ fileName: 'sample.dcm', bytes })
      )
      const parsed = parseDicomFile(bytes)
      if (Either.isLeft(parsed)) throw new Error(parsed.left.reason)
      const patientId = patientOriginalId(parsed.right)
      expect(patientId).toBeDefined()
      expect(sourceFile.subject?.reference).toBe(
        `Patient/${localResourceId(DICOM_SYSTEM, 'Patient', patientId ?? '')}`
      )
    })

    it('forwards a caller-supplied subject instead of discarding it', async () => {
      const sourceFile = await Effect.runPromise(
        dicomImporterDescriptor.buildSourceFile(
          { fileName: 'sample.dcm', bytes: sampleDicomBytes() },
          { subject: { reference: 'Patient/caller-supplied' } }
        )
      )
      expect(sourceFile.subject?.reference).toBe('Patient/caller-supplied')
    })
  })
})
