import { parseDicomFile } from 'dicom'
import { writeDicom } from 'dicom/test-helpers'
import { DateTime, Effect, Either, Option } from 'effect'
import { localResourceId } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import { PickedFileSource, SourceFile, type PickedFile, type ReadUnit } from 'importer-fundamentals'
import { describe, expect, it } from 'vite-plus/test'

import { dicomImporter, patientSubjectOf } from './descriptor.ts'
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

describe('dicomImporter', () => {
  it('has the dicom format tag', () => {
    expect(dicomImporter.format).toBe('dicom')
  })

  it('detects a file with DICM magic bytes at offset 128', () => {
    const bytes = new Uint8Array(132)
    bytes.set([0x44, 0x49, 0x43, 0x4d], 128)
    expect(dicomImporter.detect(bytes, 'unknown')).toBe(true)
  })

  it('detects a file by .dcm extension', () => {
    expect(dicomImporter.detect(new Uint8Array(), 'scan.dcm')).toBe(true)
    expect(dicomImporter.detect(new Uint8Array(), 'Scan.DCM')).toBe(true)
  })

  it('does not claim a non-DICOM file', () => {
    const json = new TextEncoder().encode('{"log":{"version":"1.2"}}')
    expect(dicomImporter.detect(json, 'capture.har')).toBe(false)
  })

  it('defaultSettings carries a time zone the runtime can resolve', () => {
    expect(dicomImporter.defaultSettings).toEqual(defaultDicomSettings)
    expect(Object.keys(dicomImporter.defaultSettings)).toEqual(['timeZone'])
    expect(Option.isSome(DateTime.zoneMakeNamed(defaultDicomSettings.timeZone))).toBe(true)
  })

  describe('decode', () => {
    /** The `Patient/<id>` reference the header's patient identity derives. */
    const headerPatientReference = (bytes: Uint8Array): string => {
      const parsed = parseDicomFile(bytes)
      if (Either.isLeft(parsed)) throw new Error(parsed.left.reason)
      const originalId = patientOriginalId(parsed.right)
      if (originalId === undefined) throw new Error('expected a patient identity in the header')
      return `Patient/${localResourceId(DICOM_SYSTEM, 'Patient', originalId)}`
    }

    const readUnit = async (file: PickedFile): Promise<ReadUnit<FhirResource, string>> => {
      const outcomes = await Effect.runPromise(dicomImporter.decode([file], defaultDicomSettings))
      expect(outcomes).toHaveLength(1)
      const outcome = outcomes[0]
      if (!Either.isRight(outcome)) throw new Error('expected a read unit')
      return outcome.right
    }

    /** The one id every resource of a unit must agree on: its source file's. */
    const sourceFileIdOfUnit = (unit: ReadUnit<FhirResource, string>): string => {
      const [section] = unit.decoded.sections
      expect(section.title).toBe(SourceFile.SECTION_TITLE)
      expect(section.resources).toHaveLength(1)
      const [row] = section.resources
      expect(row.key).toBe(SourceFile.key('sample.dcm'))
      expect(row.resource.resourceType).toBe('DocumentReference')
      const { id } = row.resource
      if (id === null) throw new Error('expected a minted source file id')
      return id
    }

    const imagingStudyInstanceId = (unit: ReadUnit<FhirResource, string>): string | undefined => {
      for (const section of unit.decoded.sections) {
        for (const { resource } of section.resources) {
          if (resource.resourceType !== 'ImagingStudy') continue
          const [extension] = resource.series[0].instance[0].extension
          expect(extension.url).toBe('gridfsFileId')
          return extension.valueString ?? undefined
        }
      }
      return undefined
    }

    it('mints a source file subject to the header-derived Patient for a local pick', async () => {
      const bytes = sampleDicomBytes()
      const unit = await readUnit({ fileName: 'sample.dcm', bytes, source: PickedFileSource.local })
      const [section] = unit.decoded.sections
      expect(section.title).toBe(SourceFile.SECTION_TITLE)
      const [row] = section.resources
      expect(row.key).toBe(SourceFile.key('sample.dcm'))
      if (row.resource.resourceType !== 'DocumentReference')
        throw new Error('expected a source file')
      expect(row.resource.subject?.reference).toBe(headerPatientReference(bytes))
    })

    it('stamps every extracted resource, and the ImagingStudy instance, with that one id', async () => {
      const unit = await readUnit({
        fileName: 'sample.dcm',
        bytes: sampleDicomBytes(),
        source: PickedFileSource.local,
      })
      const id = sourceFileIdOfUnit(unit)
      const extracted = unit.decoded.sections.slice(1).flatMap((section) => section.resources)
      expect(extracted.length).toBeGreaterThan(0)
      for (const { resource } of extracted) {
        expect(resource.meta?.source).toBe(`DocumentReference/${id}`)
      }
      expect(imagingStudyInstanceId(unit)).toBe(id)
    })

    it('reviews no source file for a server pick and links its existing one', async () => {
      const unit = await readUnit({
        fileName: 'sample.dcm',
        bytes: sampleDicomBytes(),
        source: PickedFileSource.server('doc-9'),
      })
      for (const section of unit.decoded.sections) {
        expect(section.title).not.toBe(SourceFile.SECTION_TITLE)
        for (const { resource } of section.resources) {
          expect(resource.meta?.source).toBe('DocumentReference/doc-9')
        }
      }
      expect(imagingStudyInstanceId(unit)).toBe('doc-9')
    })

    it('yields one unreadable unit for bytes that are not DICOM', async () => {
      const outcomes = await Effect.runPromise(
        dicomImporter.decode(
          [
            {
              fileName: 'sample.dcm',
              bytes: new TextEncoder().encode('not a dicom file'),
              source: PickedFileSource.local,
            },
          ],
          defaultDicomSettings
        )
      )
      expect(outcomes.map(Either.isLeft)).toEqual([true])
    })
  })

  describe('patientSubjectOf', () => {
    it('has no subject for a header with no patient identity', () => {
      const bytes = writeDicom({
        StudyInstanceUID: '1.2.3.4.5',
        SeriesInstanceUID: '1.2.3.4.5.1',
        SOPInstanceUID: '1.2.3.4.5.1.1',
        Modality: 'CT',
      })
      expect(
        patientSubjectOf({ fileName: 'sample.dcm', bytes, source: PickedFileSource.local })
      ).toBeUndefined()
    })
  })
})
