import { Effect, ParseResult } from 'effect'
import * as fc from 'fast-check'
import {
  FileImporter,
  PickedFile,
  DecodedFile,
  SourceFile,
  FormatDecode,
  DecodeFunction,
} from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { decodeLifeLabsPdfDocument } from './decode.ts'
import { lifeLabsPdfImporter } from './descriptor.ts'
import { detectLifeLabsPdf } from './detect.ts'
import { arbitrary as reportArbitrary } from './entities/report-arbitrary.ts'
import type * as Report from './entities/report.ts'
import { defaultLifeLabsPdfSettings } from './settings.ts'
import { LIFELABS_PDF_SOURCE_FILE_CODE, LIFELABS_SYSTEM } from './source-system.ts'
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
  // Closes over `reports`, so it is built per call rather than at module scope.
  const decodeConfig = {
    format,
    decodeOne: (_file: PickedFile.Type, settings: typeof SETTINGS) =>
      decodeLifeLabsPdfDocument(layoutDocument(reports), settings),
  } as const
  return FileImporter.make({
    format,
    sourceFileFormat,
    decode: DecodeFunction.fromPerFile(decodeConfig),
    display: { title: 'LifeLabs report', description: 'Test' },
    detect: detectLifeLabsPdf,
    defaultSettings: SETTINGS,
  })
}

const readUnit = (result: FormatDecode.Result<string>): FormatDecode.Result<string>['decoded'] => {
  if (result.unreadableFiles.length > 0) {
    throw new Error(
      `expected a readable result, got ${result.unreadableFiles.length} unreadable files`
    )
  }
  return result.decoded
}

describe('lifeLabsPdfImporter decode', () => {
  it('property: a local pick is reviewed with its minted source file, and every resource points at it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }),
        async (reports) => {
          const file: PickedFile.Type = {
            fileName: 'Reports.pdf',
            bytes: new TextEncoder().encode('%PDF-1.7 stand-in'),
            source: PickedFile.Source.local,
          }

          const decoded = readUnit(
            await Effect.runPromise(importerForReports(reports).decode([file], SETTINGS))
          )

          const [sourceSection] = decoded.sections
          expect(sourceSection?.title).toBe(SourceFile.SECTION_TITLE)
          const sourceRow = sourceSection?.resources[0]
          expect(sourceSection?.resources).toHaveLength(1)
          expect(sourceRow?.key).toBe(
            `${FormatDecode.keyPrefix(0, file)}${SourceFile.key(file.fileName)}`
          )
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

  it('property: a server pick mints no source file and points its resources at the one it came with', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }),
        async (reports) => {
          const file: PickedFile.Type = {
            fileName: 'Reports.pdf',
            bytes: new TextEncoder().encode('%PDF-1.7 stand-in'),
            source: PickedFile.Source.server('wf-already-uploaded'),
          }

          const decoded = readUnit(
            await Effect.runPromise(importerForReports(reports).decode([file], SETTINGS))
          )

          expect(decoded.sections.map((section) => section.title)).not.toContain(
            SourceFile.SECTION_TITLE
          )
          const labeled = DecodedFile.resources(decoded)
          expect(labeled.length).toBeGreaterThan(0)
          for (const item of labeled) {
            expect(item.resource.meta?.source).toBe(SourceFile.makeReference('wf-already-uploaded'))
          }
        }
      ),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })

  it('collects an unreadable file for bytes that are not a PDF', async () => {
    const file: PickedFile.Type = {
      fileName: 'not-a-report.pdf',
      bytes: new TextEncoder().encode('this is not a PDF at all'),
      source: PickedFile.Source.local,
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
