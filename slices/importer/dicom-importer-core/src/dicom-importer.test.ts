import { PickedFile } from '@wildflowerhealthio/importer-fundamentals'
import { DateTime, Effect, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { dicomImporter } from './dicom-importer.ts'
import { defaultDicomSettings } from './settings.ts'
import {
  DICOM_SOURCE_FILE_CODE,
  DICOM_SOURCE_FILE_CONTENT_TYPE,
  DICOM_SYSTEM,
} from './source-system.ts'

/**
 * The source file this format's importer mints for a picked file — the schema
 * driven under `dicomImporter`'s own format constants, which is the same
 * context its batch `decode` mints under.
 */
const mint = (bytes: Uint8Array, fileName = 'scan.dcm'): Promise<PickedFile.SourceFile> =>
  Effect.runPromise(
    Schema.encode(PickedFile.FromDocumentReference)({
      id: `0:${fileName}`,
      fileName,
      bytes,
    }).pipe(Effect.provideService(PickedFile.Format, dicomImporter.sourceFileFormat))
  )

describe('DICOM source file coding', () => {
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

  it('mints a resource that reads back as its own source file, bytes and name recovered', async () => {
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
      expect(result.fileSets).toHaveLength(0)
      expect(result.unreadableFiles).toHaveLength(1)
    })
  })
})
