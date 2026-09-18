import { parseDicomFile } from 'dicom'
import { writeDicom } from 'dicom/test-helpers'
import { DateTime, Effect, Either, Option, Schema } from 'effect'
import { localResourceId } from 'fhir-r4/identity'
import { Patient } from 'fhir-r4/resources'
import { PickedFile, SourceFile, type FormatDecode } from 'importer-fundamentals'
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

    const readUnit = async (file: PickedFile.PickedFile): Promise<FormatDecode.Result<string>> => {
      const result = await Effect.runPromise(dicomImporter.decode([file], defaultDicomSettings))
      if (result.unreadableFiles.length > 0) throw new Error('expected a readable result')
      return result
    }

    /** The one id every resource of a result must agree on: its source file's. */
    const sourceFileIdOfUnit = (unit: FormatDecode.Result<string>): string => {
      const [section] = unit.decoded.sections
      expect(section.title).toBe(SourceFile.SECTION_TITLE)
      expect(section.resources).toHaveLength(1)
      const [row] = section.resources
      expect(row.key).toBe(`0:sample.dcm/${SourceFile.key('sample.dcm')}`)
      expect(row.resource.resourceType).toBe('DocumentReference')
      const { id } = row.resource
      if (id === null) throw new Error('expected a minted source file id')
      return id
    }

    const imagingStudyInstanceId = (unit: FormatDecode.Result<string>): string | undefined => {
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
      const unit = await readUnit({
        fileName: 'sample.dcm',
        bytes,
        source: PickedFile.Source.local,
      })
      const [section] = unit.decoded.sections
      expect(section.title).toBe(SourceFile.SECTION_TITLE)
      const [row] = section.resources
      expect(row.key).toBe(`0:sample.dcm/${SourceFile.key('sample.dcm')}`)
      if (row.resource.resourceType !== 'DocumentReference')
        throw new Error('expected a source file')
      expect(row.resource.subject?.reference).toBe(headerPatientReference(bytes))
    })

    it('stamps every extracted resource, and the ImagingStudy instance, with that one id', async () => {
      const unit = await readUnit({
        fileName: 'sample.dcm',
        bytes: sampleDicomBytes(),
        source: PickedFile.Source.local,
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
        source: PickedFile.Source.server('doc-9'),
      })
      for (const section of unit.decoded.sections) {
        expect(section.title).not.toBe(SourceFile.SECTION_TITLE)
        for (const { resource } of section.resources) {
          expect(resource.meta?.source).toBe('DocumentReference/doc-9')
        }
      }
      expect(imagingStudyInstanceId(unit)).toBe('doc-9')
    })

    it('collects an unreadable file for bytes that are not DICOM', async () => {
      const result = await Effect.runPromise(
        dicomImporter.decode(
          [
            {
              fileName: 'sample.dcm',
              bytes: new TextEncoder().encode('not a dicom file'),
              source: PickedFile.Source.local,
            },
          ],
          defaultDicomSettings
        )
      )
      expect(result.decoded.sections).toHaveLength(0)
      expect(result.unreadableFiles).toHaveLength(1)
    })
  })

  describe('patientSubjectOf', () => {
    const anyFile: PickedFile.PickedFile = {
      fileName: 'sample.dcm',
      bytes: new Uint8Array(),
      source: PickedFile.Source.local,
    }

    it('has no subject when the decode synthesized no Patient', () => {
      // A header with no PatientID and no PatientName decodes to no resources
      // at all, so there is nothing to file the raw image under.
      expect(patientSubjectOf(anyFile, { sections: [], notes: [] })).toBeUndefined()
    })

    it('names the Patient the decode synthesized, without re-parsing the file', () => {
      const patient = Schema.decodeUnknownSync(Patient.Schema)({
        resourceType: 'Patient',
        id: 'wf-patient-1',
      })
      expect(
        patientSubjectOf(anyFile, {
          sections: [
            { title: 'CT', resources: [{ key: 'patient', title: 'Patient', resource: patient }] },
          ],
          notes: [],
        })
      ).toEqual({ reference: 'Patient/wf-patient-1' })
    })
  })
})
