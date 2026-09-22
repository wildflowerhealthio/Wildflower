import { Effect, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import type { DocumentReference } from 'fhir-r4/resources'
import {
  DecodeFunction,
  type FileImporter,
  PickedFile,
  DecodedFile,
  FormatDecode,
} from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { decodeLifeLabsPdfDocument } from './decode.ts'
import { detectLifeLabsPdf } from './detect.ts'
import { arbitrary as reportArbitrary } from './entities/report-arbitrary.ts'
import type * as Report from './entities/report.ts'
import { lifeLabsPdfImporter } from './lifelabs-pdf-importer.ts'
import { defaultLifeLabsPdfSettings } from './settings.ts'
import {
  LIFELABS_PDF_SOURCE_FILE_CODE,
  LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE,
  LIFELABS_SYSTEM,
} from './source-system.ts'
import { layoutDocument } from './test-helpers.ts'

describe('lifeLabsPdfImporter', () => {
  it('has the lifelabs-pdf format tag', () => {
    expect(lifeLabsPdfImporter.format).toBe('lifelabs-pdf')
  })

  it('detects a PDF by `%PDF-` magic bytes and by the `.pdf` extension', () => {
    const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
    expect(lifeLabsPdfImporter.detect(pdfMagic, 'unknown')).toBe(true)
    expect(lifeLabsPdfImporter.detect(new Uint8Array(), 'report.pdf')).toBe(true)
    expect(lifeLabsPdfImporter.detect(new Uint8Array(), 'report.PDF')).toBe(true)
  })

  it('does not claim a HAR-shaped file — neither the extension nor the bytes match', () => {
    const jsonLike = new TextEncoder().encode('{"log":{"version":"1.2"}}')
    expect(lifeLabsPdfImporter.detect(jsonLike, 'capture.har')).toBe(false)
    expect(lifeLabsPdfImporter.detect(jsonLike, 'export.json')).toBe(false)
  })

  it('defaultSettings has a timeZone', () => {
    expect(lifeLabsPdfImporter.defaultSettings).toEqual(defaultLifeLabsPdfSettings)
    expect(lifeLabsPdfImporter.defaultSettings.timeZone).toBe('America/Toronto')
  })
})

const SETTINGS = { timeZone: 'America/Vancouver' }

const sourceFileFormat = {
  coding: { system: LIFELABS_SYSTEM, code: LIFELABS_PDF_SOURCE_FILE_CODE },
  contentType: 'application/pdf',
  descriptionPrefix: 'LifeLabs report: ',
}

const importerForReports = (
  reports: readonly Report.Type[]
): FileImporter.Type<typeof SETTINGS, 'lifelabs-pdf'> => {
  const format = 'lifelabs-pdf'
  return {
    format,
    sourceFileFormat,
    // The decode closes over `reports`, so the importer is built per call
    // rather than at module scope.
    decode: DecodeFunction.make({
      format,
      sourceFileFormat,
      decodeFileSet: (_members, settings: typeof SETTINGS) =>
        decodeLifeLabsPdfDocument(layoutDocument(reports), settings),
    }),
    display: { title: 'LifeLabs report', description: 'Test' },
    detect: detectLifeLabsPdf,
    defaultSettings: SETTINGS,
  }
}

const readDecoded = (
  result: FormatDecode.Result<string>
): FormatDecode.Result<string>['decoded'] => {
  if (result.unreadableFiles.length > 0) {
    throw new Error(
      `expected a readable result, got ${result.unreadableFiles.length} unreadable files`
    )
  }
  return result.decoded
}

describe('lifeLabsPdfImporter decode', () => {
  it('property: a pick is reviewed with its minted archive, and every resource points at it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }),
        async (reports) => {
          const file: PickedFile.Type = {
            id: '0:Reports.pdf',
            fileName: 'Reports.pdf',
            bytes: new TextEncoder().encode('%PDF-1.7 stand-in'),
          }

          const decoded = readDecoded(
            await Effect.runPromise(importerForReports(reports).decode([file], SETTINGS))
          )

          const [sourceSection] = decoded.sections
          expect(sourceSection?.title).toBe('Source file')
          const sourceRow = sourceSection?.resources[0]
          expect(sourceSection?.resources).toHaveLength(1)
          expect(sourceRow?.key).toBe(`${FormatDecode.keyPrefix(file)}source-file/${file.fileName}`)
          expect(sourceRow?.resource.resourceType).toBe('DocumentReference')
          const sourceId = sourceRow?.resource.id
          expect(sourceId).toEqual(expect.any(String))
          for (const item of DecodedFile.resources(decoded).slice(1)) {
            expect(item.resource.meta?.source).toBe(`DocumentReference/${String(sourceId)}`)
          }
        }
      ),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })

  it('collects an unreadable file for bytes that are not a PDF', async () => {
    const file: PickedFile.Type = {
      id: '0:not-a-report.pdf',
      fileName: 'not-a-report.pdf',
      bytes: new TextEncoder().encode('this is not a PDF at all'),
    }

    const result = await Effect.runPromise(
      lifeLabsPdfImporter.decode([file], defaultLifeLabsPdfSettings)
    )

    expect(result.decoded.sections).toHaveLength(0)
    expect(result.unreadableFiles).toHaveLength(1)
    const [unreadable] = result.unreadableFiles
    expect(unreadable?.title).toBe(file.fileName)
    expect(unreadable?.pickedFile).toEqual(file)
    expect(ParseResult.isParseError(unreadable?.error)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The archive this format's importer mints — the schema driven under
// `lifeLabsPdfImporter`'s own format constants, which is the same context its
// batch `decode` mints under.
// ---------------------------------------------------------------------------

const mintArchive = (
  bytes: Uint8Array,
  fileName = 'lab-report.pdf'
): Promise<DocumentReference.Type> =>
  Effect.runPromise(
    Schema.encode(PickedFile.FromDocumentReference)({
      id: `0:${fileName}`,
      fileName,
      bytes,
    }).pipe(Effect.provideService(PickedFile.Format, lifeLabsPdfImporter.sourceFileFormat))
  )

describe('LifeLabs PDF archive coding', () => {
  it('carries the LifeLabs coding on type and category, no security label, and pdf content', async () => {
    const resource = await mintArchive(new TextEncoder().encode('%PDF-1.7\ntest'))

    expect(resource.type?.coding[0]?.system?.toString()).toBe(LIFELABS_SYSTEM)
    expect(resource.type?.coding[0]?.code).toBe(LIFELABS_PDF_SOURCE_FILE_CODE)
    expect(resource.category[0]?.coding[0]?.system?.toString()).toBe(LIFELABS_SYSTEM)
    expect(resource.category[0]?.coding[0]?.code).toBe(LIFELABS_PDF_SOURCE_FILE_CODE)
    expect((resource.securityLabel ?? []).length).toBe(0)
    expect(resource.content[0]?.attachment?.contentType).toBe(LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE)
    expect(resource.description).toBe('LifeLabs report: lab-report.pdf')
    expect(PickedFile.isSourceFile(lifeLabsPdfImporter.sourceFileFormat)(resource)).toBe(true)
  })

  it('exposes the category search token in system|code form', () => {
    expect(PickedFile.categoryToken(lifeLabsPdfImporter.sourceFileFormat)).toBe(
      `${LIFELABS_SYSTEM}|${LIFELABS_PDF_SOURCE_FILE_CODE}`
    )
  })

  it('mints a resource that reads back as its own archive, bytes and name recovered', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\n%\xff\xfa\nround-trip')
    const resource = await mintArchive(bytes, 'my-report.pdf')

    const back = await Effect.runPromise(
      Schema.decode(PickedFile.FromDocumentReference)(resource).pipe(
        Effect.provideService(PickedFile.Format, lifeLabsPdfImporter.sourceFileFormat)
      )
    )
    expect(back.fileName).toBe('my-report.pdf')
    expect(back.bytes).toEqual(bytes)
  })
})
