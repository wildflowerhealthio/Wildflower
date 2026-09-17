import { Effect, ParseResult } from 'effect'
import * as fc from 'fast-check'
import type { FhirResource } from 'fhir-r4/resources'
import {
  type DecodedUnit,
  type DecodeOutcome,
  type FileImporterDescriptor,
  PickedFileSource,
  type PickedFile,
  sectionResources,
  SourceFile,
  SourceFileFhirReference,
} from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { decodeLifeLabsPdfDocument } from './decode.ts'
import { lifeLabsPdfImporterDescriptor } from './descriptor.ts'
import { arbitrary as reportArbitrary } from './entities/report-arbitrary.ts'
import type * as Report from './entities/report.ts'
import { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
import { lifeLabsPdfSourceFileCodec } from './source-file/index.ts'
import { layoutDocument } from './test-helpers.ts'

describe('lifeLabsPdfImporterDescriptor', () => {
  it('has the lifelabs-pdf format tag', () => {
    expect(lifeLabsPdfImporterDescriptor.format).toBe('lifelabs-pdf')
  })

  it('detects a PDF by `%PDF-` magic bytes and by the `.pdf` extension', () => {
    const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
    expect(lifeLabsPdfImporterDescriptor.detect(pdfMagic, 'unknown')).toBe(true)
    expect(lifeLabsPdfImporterDescriptor.detect(new Uint8Array(), 'report.pdf')).toBe(true)
    expect(lifeLabsPdfImporterDescriptor.detect(new Uint8Array(), 'report.PDF')).toBe(true)
  })

  it('does not claim a HAR-shaped file — neither the extension nor the bytes match', () => {
    const jsonLike = new TextEncoder().encode('{"log":{"version":"1.2"}}')
    expect(lifeLabsPdfImporterDescriptor.detect(jsonLike, 'capture.har')).toBe(false)
    expect(lifeLabsPdfImporterDescriptor.detect(jsonLike, 'export.json')).toBe(false)
  })

  it('defaultSettings has a timeZone', () => {
    expect(lifeLabsPdfImporterDescriptor.defaultSettings).toEqual(defaultLifeLabsPdfSettings)
    expect(lifeLabsPdfImporterDescriptor.defaultSettings.timeZone).toBe('America/Toronto')
  })
})

/**
 * The decode the descriptor exposes is {@link decodeLifeLabsPdfDocument}
 * lifted through `SourceFile.perFileDecode`. The pdfjs extraction seam in between is
 * untested-by-design (no PDF writer in this package, and the anonymizer's
 * descriptor makes the same call), so the source-file behaviour `SourceFile.perFileDecode`
 * adds is driven over the same lift with the extraction replaced by
 * `layoutDocument`'s printed inverse — everything below the seam is the real
 * decode. The descriptor's own `decode` covers the failure side, where the
 * bytes never reach a report.
 */

const SETTINGS = { timeZone: 'America/Vancouver' }

/** The lift the descriptor uses, with the printed document standing in for the PDF. */
const decodeReports = (
  reports: readonly Report.Type[]
): FileImporterDescriptor<LifeLabsPdfSettings, FhirResource>['decode'] =>
  SourceFile.perFileDecode<LifeLabsPdfSettings, FhirResource>(
    lifeLabsPdfSourceFileCodec,
    (_file, settings) => decodeLifeLabsPdfDocument(layoutDocument(reports), settings)
  )

/** The one `read` unit a single-file decode yields, or a failure naming what came back. */
const readUnit = <TParsed>(
  outcomes: readonly DecodeOutcome<TParsed>[]
): DecodedUnit<TParsed>['decoded'] => {
  expect(outcomes).toHaveLength(1)
  const [outcome] = outcomes
  if (outcome === undefined || outcome._tag !== 'read') {
    throw new Error(`expected one read unit, got ${JSON.stringify(outcomes.map((o) => o._tag))}`)
  }
  return outcome.decoded
}

describe('lifeLabsPdfImporterDescriptor decode', () => {
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
            await Effect.runPromise(decodeReports(reports)([file], SETTINGS))
          )

          const [sourceSection, ...reportSections] = decoded.sections
          expect(sourceSection?.title).toBe(SourceFile.SECTION_TITLE)
          const sourceRow = sourceSection?.resources[0]
          expect(sourceSection?.resources).toHaveLength(1)
          expect(sourceRow?.key).toBe(SourceFile.key(file.fileName))
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
            await Effect.runPromise(decodeReports(reports)([file], SETTINGS))
          )

          expect(decoded.sections.map((section) => section.title)).not.toContain(
            SourceFile.SECTION_TITLE
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
      lifeLabsPdfImporterDescriptor.decode([file], defaultLifeLabsPdfSettings)
    )

    expect(outcomes).toHaveLength(1)
    const [outcome] = outcomes
    expect(outcome?._tag).toBe('unreadable')
    expect(outcome?.title).toBe(file.fileName)
    expect(outcome?.files).toEqual([file])
    if (outcome?._tag === 'unreadable') {
      expect(ParseResult.isParseError(outcome.error)).toBe(true)
    }
  })
})
