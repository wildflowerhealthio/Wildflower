import { Effect } from 'effect'
import type { DocumentReferenceType } from 'importer-fundamentals'
import { describe, expect, it } from 'vite-plus/test'

import { DICOM_SYSTEM } from '../source-system.ts'
import {
  buildSourceFile,
  DICOM_SOURCE_FILE_CATEGORY_TOKEN,
  DICOM_SOURCE_FILE_CODE,
  DICOM_SOURCE_FILE_CONTENT_TYPE,
  dicomSourceFileFromDocumentReference,
  isDicomSourceFile,
} from './dicom-source-file-codec.ts'

/**
 * The shared codec machinery — round trip, hash/size, `subject`, verbatim
 * bytes, the deterministic id — is pinned once in `importer-fundamentals`'
 * `source-file-codec.test.ts`. This file asserts only what is
 * DICOM-specific: the DICOM coding, the `application/dicom` content type.
 */

const mint = (bytes: Uint8Array, fileName = 'scan.dcm'): Promise<DocumentReferenceType> =>
  Effect.runPromise(buildSourceFile({ fileName, bytes }))

describe('DICOM source file coding', () => {
  it('carries the DICOM coding on type and category, and application/dicom content', async () => {
    const resource = await mint(new Uint8Array([0x00, 0x01, 0x02]))

    expect(resource.type?.coding[0]?.system?.toString()).toBe(DICOM_SYSTEM)
    expect(resource.type?.coding[0]?.code).toBe(DICOM_SOURCE_FILE_CODE)
    expect(resource.category[0]?.coding[0]?.system?.toString()).toBe(DICOM_SYSTEM)
    expect(resource.category[0]?.coding[0]?.code).toBe(DICOM_SOURCE_FILE_CODE)
    expect(resource.content[0]?.attachment?.contentType).toBe(DICOM_SOURCE_FILE_CONTENT_TYPE)
    expect(resource.description).toBe('DICOM file: scan.dcm')
    expect(isDicomSourceFile(resource)).toBe(true)
  })

  it('exposes the category search token in system|code form', () => {
    expect(DICOM_SOURCE_FILE_CATEGORY_TOKEN).toBe(`${DICOM_SYSTEM}|${DICOM_SOURCE_FILE_CODE}`)
  })

  it('mints a resource that reads back as its own source file, bytes and name recovered', async () => {
    const bytes = new Uint8Array(132)
    bytes.set([0x44, 0x49, 0x43, 0x4d], 128)
    const resource = await mint(bytes, 'my-scan.dcm')

    const back = await Effect.runPromise(dicomSourceFileFromDocumentReference(resource))
    expect(back.fileName).toBe('my-scan.dcm')
    expect(back.bytes).toEqual(bytes)
  })
})
