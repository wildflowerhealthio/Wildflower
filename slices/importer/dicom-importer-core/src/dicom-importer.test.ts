import { DicomHeader } from 'dicom'
import { writeDicom } from 'dicom/test-helpers'
import { DateTime, Effect, Either, Option, Schema } from 'effect'
import { localResourceId } from 'fhir-r4/identity'
import type { DocumentReference } from 'fhir-r4/resources'
import { PickedFile, type FormatDecode } from 'importer-fundamentals'
import { describe, expect, it } from 'vite-plus/test'

import { dicomImporter } from './dicom-importer.ts'
import { patientOriginalId } from './fhir/to-fhir.ts'
import { defaultDicomSettings } from './settings.ts'
import {
  DICOM_SOURCE_FILE_CODE,
  DICOM_SOURCE_FILE_CONTENT_TYPE,
  DICOM_SYSTEM,
} from './source-system.ts'

/**
 * The archive this format's importer mints for a picked file — the schema
 * driven under `dicomImporter`'s own format constants, which is the same
 * context its batch `decode` mints under.
 */
const mint = (bytes: Uint8Array, fileName = 'scan.dcm'): Promise<DocumentReference.Type> =>
  Effect.runPromise(
    Schema.encode(PickedFile.FromDocumentReference)({
      id: `0:${fileName}`,
      fileName,
      bytes,
    }).pipe(Effect.provideService(PickedFile.Format, dicomImporter.sourceFileFormat))
  )

describe('DICOM archive coding', () => {
  it('carries the DICOM coding on type and category, and application/dicom content', async () => {
    const resource = await mint(new Uint8Array([0x00, 0x01, 0x02]))

    expect(resource.type?.coding[0]?.system?.toString()).toBe(DICOM_SYSTEM)
    expect(resource.type?.coding[0]?.code).toBe(DICOM_SOURCE_FILE_CODE)
    expect(resource.category[0]?.coding[0]?.system?.toString()).toBe(DICOM_SYSTEM)
    expect(resource.category[0]?.coding[0]?.code).toBe(DICOM_SOURCE_FILE_CODE)
    expect(resource.content[0]?.attachment?.contentType).toBe(DICOM_SOURCE_FILE_CONTENT_TYPE)
    expect(resource.description).toBe('DICOM image: scan.dcm')
    expect(PickedFile.isSourceFile(dicomImporter.sourceFileFormat)(resource)).toBe(true)
  })

  it('exposes the category search token in system|code form', () => {
    expect(PickedFile.categoryToken(dicomImporter.sourceFileFormat)).toBe(
      `${DICOM_SYSTEM}|${DICOM_SOURCE_FILE_CODE}`
    )
  })

  it('mints a resource that reads back as its own archive, bytes and name recovered', async () => {
    const bytes = new Uint8Array(132)
    bytes.set([0x44, 0x49, 0x43, 0x4d], 128)
    const resource = await mint(bytes, 'my-scan.dcm')

    const back = await Effect.runPromise(
      Schema.decode(PickedFile.FromDocumentReference)(resource).pipe(
        Effect.provideService(PickedFile.Format, dicomImporter.sourceFileFormat)
      )
    )
    expect(back.fileName).toBe('my-scan.dcm')
    expect(back.bytes).toEqual(bytes)
  })
})

const sampleDicomBytes = (): Uint8Array =>
  writeDicom({
    StudyInstanceUID: '1.2.3.4.5',
    SeriesInstanceUID: '1.2.3.4.5.1',
    SOPInstanceUID: '1.2.3.4.5.1.1',
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
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
      const parsed = DicomHeader.tryFromDicomFile(bytes)
      if (Either.isLeft(parsed)) throw new Error(parsed.left.reason)
      const originalId = patientOriginalId(parsed.right)
      if (originalId === undefined) throw new Error('expected a patient identity in the header')
      return `Patient/${localResourceId(DICOM_SYSTEM, 'Patient', originalId)}`
    }

    const readStudy = async (file: PickedFile.Type): Promise<FormatDecode.Result<string>> => {
      const result = await Effect.runPromise(dicomImporter.decode([file], defaultDicomSettings))
      if (result.unreadableFiles.length > 0) throw new Error('expected a readable result')
      return result
    }

    /** The one id every resource of a result must agree on: its archive's. */
    const sourceFileIdOfStudy = (result: FormatDecode.Result<string>): string => {
      const [section] = result.decoded.sections
      expect(section.title).toBe('Source file')
      expect(section.resources).toHaveLength(1)
      const [row] = section.resources
      expect(row.key).toBe('0:sample.dcm/source-file/sample.dcm')
      expect(row.resource.resourceType).toBe('DocumentReference')
      const { id } = row.resource
      if (id === null) throw new Error('expected a minted archive id')
      return id
    }

    const imagingStudyInstanceId = (result: FormatDecode.Result<string>): string | undefined => {
      for (const section of result.decoded.sections) {
        for (const { resource } of section.resources) {
          if (resource.resourceType !== 'ImagingStudy') continue
          const [extension] = resource.series[0].instance[0].extension
          expect(extension.url).toBe('gridfsFileId')
          return extension.valueString ?? undefined
        }
      }
      return undefined
    }

    it('mints an archive subject to the header-derived Patient', async () => {
      const bytes = sampleDicomBytes()
      const study = await readStudy({ id: '0:sample.dcm', fileName: 'sample.dcm', bytes })
      const [section] = study.decoded.sections
      expect(section.title).toBe('Source file')
      const [row] = section.resources
      expect(row.key).toBe('0:sample.dcm/source-file/sample.dcm')
      if (row.resource.resourceType !== 'DocumentReference') throw new Error('expected an archive')
      expect(row.resource.subject?.reference).toBe(headerPatientReference(bytes))
    })

    it('stamps every extracted resource, and the ImagingStudy instance, with that one id', async () => {
      const study = await readStudy({
        id: '0:sample.dcm',
        fileName: 'sample.dcm',
        bytes: sampleDicomBytes(),
      })
      const id = sourceFileIdOfStudy(study)
      const extracted = study.decoded.sections.slice(1).flatMap((section) => section.resources)
      expect(extracted.length).toBeGreaterThan(0)
      for (const { resource } of extracted) {
        expect(resource.meta?.source).toBe(`DocumentReference/${id}`)
      }
      expect(imagingStudyInstanceId(study)).toBe(id)
    })

    it('mints the same archive id for the same file on every decode', async () => {
      const bytes = sampleDicomBytes()
      const first = await readStudy({ id: '0:sample.dcm', fileName: 'sample.dcm', bytes })
      const second = await readStudy({ id: '0:sample.dcm', fileName: 'sample.dcm', bytes })
      expect(sourceFileIdOfStudy(second)).toBe(sourceFileIdOfStudy(first))
    })

    it('collects an unreadable file for bytes that are not DICOM', async () => {
      const result = await Effect.runPromise(
        dicomImporter.decode(
          [
            {
              id: '0:sample.dcm',
              fileName: 'sample.dcm',
              bytes: new TextEncoder().encode('not a dicom file'),
            },
          ],
          defaultDicomSettings
        )
      )
      expect(result.decoded.sections).toHaveLength(0)
      expect(result.unreadableFiles).toHaveLength(1)
    })
  })
})
