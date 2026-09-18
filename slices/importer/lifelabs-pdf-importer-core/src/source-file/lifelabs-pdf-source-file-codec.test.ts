import { Effect } from 'effect'
import { type DocumentReferenceType, SourceFile } from 'importer-fundamentals'
import { describe, expect, it } from 'vite-plus/test'

import { lifeLabsPdfImporter } from '../descriptor.ts'
import {
  LIFELABS_PDF_SOURCE_FILE_CODE,
  LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE,
  LIFELABS_SYSTEM,
} from '../source-system.ts'

/**
 * The source file this format's importer mints for a picked file — the codec
 * driven under `lifeLabsPdfImporter`'s own format constants, which is the same
 * context its batch `decode` mints under.
 */
const mint = (bytes: Uint8Array, fileName = 'lab-report.pdf'): Promise<DocumentReferenceType> =>
  Effect.runPromise(
    SourceFile.mintResource({ fileName, bytes }).pipe(
      Effect.provideService(SourceFile.FormatContext, lifeLabsPdfImporter.sourceFileFormat)
    )
  )

describe('LifeLabs PDF source file coding', () => {
  it('carries the LifeLabs coding on type and category, no security label, and pdf content', async () => {
    const resource = await mint(new TextEncoder().encode('%PDF-1.7\ntest'))

    expect(resource.type?.coding[0]?.system?.toString()).toBe(LIFELABS_SYSTEM)
    expect(resource.type?.coding[0]?.code).toBe(LIFELABS_PDF_SOURCE_FILE_CODE)
    expect(resource.category[0]?.coding[0]?.system?.toString()).toBe(LIFELABS_SYSTEM)
    expect(resource.category[0]?.coding[0]?.code).toBe(LIFELABS_PDF_SOURCE_FILE_CODE)
    expect((resource.securityLabel ?? []).length).toBe(0)
    expect(resource.content[0]?.attachment?.contentType).toBe(LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE)
    expect(resource.description).toBe('LifeLabs report: lab-report.pdf')
    expect(lifeLabsPdfImporter.isSourceFile(resource)).toBe(true)
  })

  it('exposes the category search token in system|code form', () => {
    expect(lifeLabsPdfImporter.categoryToken).toBe(
      `${LIFELABS_SYSTEM}|${LIFELABS_PDF_SOURCE_FILE_CODE}`
    )
  })

  it('mints a resource that reads back as its own source file, bytes and name recovered', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\n%\xff\xfa\nround-trip')
    const resource = await mint(bytes, 'my-report.pdf')

    const back = await Effect.runPromise(
      lifeLabsPdfImporter.sourceFileFromDocumentReference(resource)
    )
    expect(back.fileName).toBe('my-report.pdf')
    expect(back.bytes).toEqual(bytes)
  })
})
