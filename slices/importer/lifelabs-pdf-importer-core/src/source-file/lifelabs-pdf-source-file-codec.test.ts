import { Effect } from 'effect'
import type { DocumentReferenceType } from 'importer-fundamentals'
import { describe, expect, it } from 'vite-plus/test'

import { LIFELABS_SYSTEM } from '../source-system.ts'
import {
  buildSourceFile,
  isLifeLabsPdfSourceFile,
  LIFELABS_PDF_SOURCE_FILE_CATEGORY_TOKEN,
  LIFELABS_PDF_SOURCE_FILE_CODE,
  LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE,
  lifeLabsPdfSourceFileFromDocumentReference,
} from './lifelabs-pdf-source-file-codec.ts'

/**
 * The shared codec machinery — round trip, hash/size, `subject`, verbatim
 * bytes, the deterministic id — is pinned once in `importer-fundamentals`'
 * `source-file-codec.test.ts`. This file asserts only what is
 * LifeLabs-specific: the LifeLabs coding, the PDF content type, and the
 * *absence* of a security label (unlike HAR, a report PDF carries no
 * redaction marker).
 */

/** Mint a LifeLabs PDF source file resource from picked bytes — the descriptor's entry point. */
const mint = (bytes: Uint8Array, fileName = 'lab-report.pdf'): Promise<DocumentReferenceType> =>
  Effect.runPromise(buildSourceFile({ fileName, bytes }))

describe('LifeLabs PDF source file coding', () => {
  it('carries the LifeLabs coding on type and category, no security label, and pdf content', async () => {
    const resource = await mint(new TextEncoder().encode('%PDF-1.7\ntest'))

    // `system` is URI-typed on the decoded schema (URL, not string); compare
    // via toString to keep the assertion resilient to that.
    expect(resource.type?.coding[0]?.system?.toString()).toBe(LIFELABS_SYSTEM)
    expect(resource.type?.coding[0]?.code).toBe(LIFELABS_PDF_SOURCE_FILE_CODE)
    expect(resource.category[0]?.coding[0]?.system?.toString()).toBe(LIFELABS_SYSTEM)
    expect(resource.category[0]?.coding[0]?.code).toBe(LIFELABS_PDF_SOURCE_FILE_CODE)
    expect((resource.securityLabel ?? []).length).toBe(0)
    expect(resource.content[0]?.attachment?.contentType).toBe(LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE)
    expect(resource.description).toBe('LifeLabs report PDF: lab-report.pdf')
    expect(isLifeLabsPdfSourceFile(resource)).toBe(true)
  })

  it('exposes the category search token in system|code form', () => {
    expect(LIFELABS_PDF_SOURCE_FILE_CATEGORY_TOKEN).toBe(
      `${LIFELABS_SYSTEM}|${LIFELABS_PDF_SOURCE_FILE_CODE}`
    )
  })

  it('mints a resource that reads back as its own source file, bytes and name recovered', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\n%\xff\xfa\nround-trip')
    const resource = await mint(bytes, 'my-report.pdf')

    const back = await Effect.runPromise(lifeLabsPdfSourceFileFromDocumentReference(resource))
    expect(back.fileName).toBe('my-report.pdf')
    expect(back.bytes).toEqual(bytes)
  })
})
