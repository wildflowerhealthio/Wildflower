import { Effect, Either, ParseResult } from 'effect'
import * as fc from 'fast-check'
import type { FhirResource } from 'fhir-r4/resources'
import {
  FileImporter,
  PickedFileSource,
  type PickedFile,
  type ReadUnit,
  sectionResources,
  SOURCE_FILE_SECTION_TITLE,
  sourceFileKey,
  SourceFileFhirReference,
} from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { decodeLifeLabsPdfDocument } from './decode.ts'
import { detectLifeLabsPdf } from './detect.ts'
import { lifeLabsPdfImporter } from './descriptor.ts'
import { arbitrary as reportArbitrary } from './entities/report-arbitrary.ts'
import type * as Report from './entities/report.ts'
import { defaultLifeLabsPdfSettings } from './settings.ts'
import {
  LIFELABS_PDF_SOURCE_FILE_CODE,
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

const importerForReports = (reports: readonly Report.Type[]) =>
  new FileImporter({
    format: 'lifelabs-pdf' as const,
    coding: { system: LIFELABS_SYSTEM, code: LIFELABS_PDF_SOURCE_FILE_CODE },
    contentType: 'application/pdf',
    display: { title: 'LifeLabs report', description: 'Test' },
    detect: detectLifeLabsPdf,
    defaultSettings: SETTINGS,
    decodeOne: (_file: PickedFile, settings: typeof SETTINGS) =>
      decodeLifeLabsPdfDocument(layoutDocument(reports), settings),
  })

const readUnit = (
  outcomes: readonly Either.Either<ReadUnit<string>, unknown>[]
): ReadUnit<string>['decoded'] => {
  expect(outcomes).toHaveLength(1)
  const [outcome] = outcomes
  if (outcome === undefined || !Either.isRight(outcome)) {
    throw new Error(
      `expected one read unit, got ${JSON.stringify(outcomes?.map((o) => (Either.isRight(o) ? 'Right' : 'Left')))}`
    )
  }
  return outcome.right.decoded
}

describe('lifeLabsPdfImporter decode', () => {
  it('property: a local pick is reviewed with its minted source file, and every resource points at it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }),
        async (reports) => {
          const file: PickedFile = {
            fileName: 'Reports.pdf',
            bytes: new TextEncoder().encode('%PDF-1.7 stand-in'),
            source: PickedFileSource.local,
          }

          const decoded = readUnit(
            await Effect.runPromise(importerForReports(reports).decode([file], SETTINGS))
          )

          const [sourceSection, ...reportSections] = decoded.sections
          expect(sourceSection?.title).toBe(SOURCE_FILE_SECTION_TITLE)
          const sourceRow = sourceSection?.resources[0]
          expect(sourceSection?.resources).toHaveLength(1)
          expect(sourceRow?.key).toBe(sourceFileKey(file.fileName))
          expect(sourceRow?.resource.resourceType).toBe('DocumentReference')
          const sourceId = sourceRow?.resource.id
          expect(sourceId).toEqual(expect.any(String))
          for (const item of sectionResources(reportSections)) {
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
          const file: PickedFile = {
            fileName: 'Reports.pdf',
            bytes: new TextEncoder().encode('%PDF-1.7 stand-in'),
            source: PickedFileSource.server('wf-already-uploaded'),
          }

          const decoded = readUnit(
            await Effect.runPromise(importerForReports(reports).decode([file], SETTINGS))
          )

          expect(decoded.sections.map((section) => section.title)).not.toContain(
            SOURCE_FILE_SECTION_TITLE
          )
          const labeled = sectionResources(decoded.sections)
          expect(labeled.length).toBeGreaterThan(0)
          for (const item of labeled) {
            expect(item.resource.meta?.source).toBe(
              SourceFileFhirReference.make('wf-already-uploaded')
            )
          }
        }
      ),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })

  it('yields one unreadable unit for bytes that are not a PDF', async () => {
    const file: PickedFile = {
      fileName: 'not-a-report.pdf',
      bytes: new TextEncoder().encode('this is not a PDF at all'),
      source: PickedFileSource.local,
    }

    const outcomes = await Effect.runPromise(
      lifeLabsPdfImporter.decode([file], defaultLifeLabsPdfSettings)
    )

    expect(outcomes).toHaveLength(1)
    const [outcome] = outcomes
    expect(outcome).toBeDefined()
    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) {
      expect(outcome.left.title).toBe(file.fileName)
      expect(outcome.left.files).toEqual([file])
      expect(ParseResult.isParseError(outcome.left.error)).toBe(true)
    }
  })
})
