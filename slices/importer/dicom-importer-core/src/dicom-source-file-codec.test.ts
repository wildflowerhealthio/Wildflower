import { Effect } from 'effect'
import { SourceFileCodec, type SourceFile } from 'importer-fundamentals'
import { describe, expect, it } from 'vite-plus/test'

import { dicomImporter } from './dicom-importer.ts'
import {
  DICOM_SOURCE_FILE_CODE,
  DICOM_SOURCE_FILE_CONTENT_TYPE,
  DICOM_SYSTEM,
} from './source-system.ts'

/**
 * The source file this format's importer mints for a picked file — the codec
 * driven under `dicomImporter`'s own format constants, which is the same
 * context its batch `decode` mints under.
 */
const mint = (
  bytes: Uint8Array,
  fileName = 'scan.dcm'
): Promise<SourceFile.DocumentReferenceType> =>
  Effect.runPromise(
    SourceFileCodec.mintResource({ fileName, bytes }).pipe(
      Effect.provideService(SourceFileCodec.FormatContext, dicomImporter.sourceFileFormat)
    )
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
    expect(dicomImporter.isSourceFile(resource)).toBe(true)
  })

  it('exposes the category search token in system|code form', () => {
    expect(dicomImporter.categoryToken).toBe(`${DICOM_SYSTEM}|${DICOM_SOURCE_FILE_CODE}`)
  })

  it('mints a resource that reads back as its own source file, bytes and name recovered', async () => {
    const bytes = new Uint8Array(132)
    bytes.set([0x44, 0x49, 0x43, 0x4d], 128)
    const resource = await mint(bytes, 'my-scan.dcm')

    const back = await Effect.runPromise(dicomImporter.sourceFileFromDocumentReference(resource))
    expect(back.fileName).toBe('my-scan.dcm')
    expect(back.bytes).toEqual(bytes)
  })
})
