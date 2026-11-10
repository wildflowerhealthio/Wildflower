import { HealthCardIdentifier, type HealthCardProvince } from '@wildflowerhealthio/fhir-ca-infoway'
import { PickedFile, SectionedList } from '@wildflowerhealthio/importer-fundamentals'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { PositionedTextExtractor, UnreadablePdf } from '@wildflowerhealthio/positioned-text'
import { Effect, Layer, Option, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

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

  it("defaultSettings are Toronto's zone and Ontario's health card", () => {
    expect(lifeLabsPdfImporter.defaultSettings).toEqual(defaultLifeLabsPdfSettings)
    expect(lifeLabsPdfImporter.defaultSettings).toEqual({
      timeZone: 'America/Toronto',
      healthCardProvince: 'ON',
    })
  })
})

const SETTINGS = { timeZone: 'America/Vancouver', healthCardProvince: 'ON' } as const

/** An extractor that reads any PDF as `reports` printed. */
const extractorPrinting = (reports: readonly Report.Type[]): Layer.Layer<PositionedTextExtractor> =>
  Layer.succeed(PositionedTextExtractor, {
    extract: () => Effect.succeed(layoutDocument(reports)),
  })

/** An extractor that cannot open any PDF. */
const extractorRefusing: Layer.Layer<PositionedTextExtractor> = Layer.succeed(
  PositionedTextExtractor,
  { extract: () => Effect.fail(new UnreadablePdf({ cause: new Error('Invalid PDF structure.') })) }
)

const pickedReport: PickedFile.Type = {
  id: '0:Reports.pdf',
  fileName: 'Reports.pdf',
  bytes: new TextEncoder().encode('%PDF-1.7 stand-in'),
}

/** `characters` printed with a run of spaces and hyphens before, between and after each. */
const printedWithSeparators = (characters: string): fc.Arbitrary<string> =>
  fc
    .array(fc.stringMatching(/^[ -]{0,2}$/), {
      minLength: characters.length + 1,
      maxLength: characters.length + 1,
    })
    .map((between) =>
      between.map((separator, index) => `${separator}${characters[index] ?? ''}`).join('')
    )

/** An `HC #` printed in a province's shape, and the identifier it is written as. */
interface PrintedHealthCard {
  readonly province: HealthCardProvince.Type
  readonly printed: string
  readonly value: string
  readonly versionCode: readonly string[]
}

const printedHealthCardArbitrary: fc.Arbitrary<PrintedHealthCard> = fc
  .oneof(
    fc.record({
      province: fc.constant('ON' as const),
      number: fc.stringMatching(/^\d{10}$/),
      versionCode: fc.array(fc.stringMatching(/^[A-Z]{1,2}$/), { maxLength: 1 }),
    }),
    fc.record({
      province: fc.constant('BC' as const),
      number: fc.stringMatching(/^\d{10}$/),
      versionCode: fc.constant([]),
    }),
    fc.record({
      province: fc.constant('Other' as const),
      number: fc.stringMatching(/^[0-9A-Z]{1,12}$/),
      versionCode: fc.constant([]),
    })
  )
  .chain(({ province, number, versionCode }) =>
    printedWithSeparators([number, ...versionCode].join('')).map((printed) => ({
      province,
      printed,
      value: number,
      versionCode,
    }))
  )

describe('lifeLabsPdfImporter decode', () => {
  it('property: a picked file is one file set of detached records, each under its own local key', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }),
        async (reports) => {
          const file: PickedFile.Type = {
            id: '0:Reports.pdf',
            fileName: 'Reports.pdf',
            bytes: new TextEncoder().encode('%PDF-1.7 stand-in'),
          }

          const decoded = await Effect.runPromise(
            lifeLabsPdfImporter
              .decode([file], SETTINGS)
              .pipe(Effect.provide(extractorPrinting(reports)))
          )

          expect(decoded.unreadableFiles).toEqual([])
          expect(decoded.fileSets.map((fileSet) => fileSet.pickedFiles)).toEqual([
            [{ pickedFile: file, identifiedAs: Option.none() }],
          ])
          const records = decoded.fileSets.flatMap((fileSet) =>
            SectionedList.rows(fileSet.sectionedList)
          )
          expect(records.map(({ resource }) => resource.id)).toEqual(records.map(() => null))
          const localKeys = records.map(({ localKey }) => localKey)
          expect(localKeys.length).toBeGreaterThan(0)
          expect(new Set(localKeys).size).toBe(localKeys.length)
        }
      ),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })

  it("property: writes the HC # in the chosen province's health card system", async () => {
    await fc.assert(
      fc.asyncProperty(reportArbitrary, printedHealthCardArbitrary, async (printed, card) => {
        const report = {
          ...printed,
          patient: { ...printed.patient, patientId: '', healthCardNumber: card.printed },
        }

        const decoded = await Effect.runPromise(
          lifeLabsPdfImporter
            .decode([pickedReport], { ...SETTINGS, healthCardProvince: card.province })
            .pipe(Effect.provide(extractorPrinting([report])))
        )

        expect(
          decoded.fileSets
            .flatMap((fileSet) => SectionedList.rows(fileSet.sectionedList))
            .flatMap(({ resource }) =>
              resource.resourceType === 'Patient' ? resource.identifier : []
            )
        ).toEqual([
          expect.objectContaining({
            system: new URL(HealthCardIdentifier.HealthCardNumberSystem[card.province]),
            value: card.value,
            extension: card.versionCode.map((valueString) =>
              expect.objectContaining({
                url: HealthCardIdentifier.ONTARIO_HEALTH_CARD_VERSION_CODE_URL,
                valueString,
              })
            ),
          }),
        ])
      }),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })

  it("property: fails the import of an Ontario HC # read as British Columbia's", async () => {
    await fc.assert(
      fc.asyncProperty(
        reportArbitrary,
        fc.stringMatching(/^\d{10}$/),
        fc.stringMatching(/^[A-Z]{1,2}$/),
        async (printed, number, versionCode) => {
          const report = {
            ...printed,
            patient: {
              ...printed.patient,
              patientId: '',
              healthCardNumber: `${number} ${versionCode}`,
            },
          }

          const decoded = await Effect.runPromise(
            lifeLabsPdfImporter
              .decode([pickedReport], { ...SETTINGS, healthCardProvince: 'BC' })
              .pipe(Effect.provide(extractorPrinting([report])))
          )

          expect(decoded.fileSets).toEqual([])
          expect(decoded.unreadableFiles.map(({ error }) => error.message)).toEqual([
            expect.stringContaining('not a British Columbia PHN: expected exactly ten digits'),
          ])
        }
      ),
      { numRuns: numRunsFor({ base: 5 }) }
    )
  })

  it('collects an unreadable file for bytes the extractor cannot open', async () => {
    const file: PickedFile.Type = {
      id: '0:not-a-report.pdf',
      fileName: 'not-a-report.pdf',
      bytes: new TextEncoder().encode('this is not a PDF at all'),
    }

    const result = await Effect.runPromise(
      lifeLabsPdfImporter
        .decode([file], defaultLifeLabsPdfSettings)
        .pipe(Effect.provide(extractorRefusing))
    )

    expect(result.fileSets).toHaveLength(0)
    expect(result.unreadableFiles).toHaveLength(1)
    const [unreadable] = result.unreadableFiles
    expect(unreadable?.title).toBe(file.fileName)
    expect(unreadable?.pickedFile).toEqual(file)
    expect(ParseResult.isParseError(unreadable?.error)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The source file the import stage mints for this format — the schema driven
// under `lifeLabsPdfImporter`'s own format constants, which is what
// `importDecoded` provides it under.
// ---------------------------------------------------------------------------

const mintSourceFile = (
  bytes: Uint8Array,
  fileName = 'lab-report.pdf'
): Promise<PickedFile.SourceFile> =>
  Effect.runPromise(
    Schema.encode(PickedFile.FromDocumentReference)({
      id: `0:${fileName}`,
      fileName,
      bytes,
    }).pipe(Effect.provideService(PickedFile.Format, lifeLabsPdfImporter.sourceFileFormat))
  )

describe('LifeLabs PDF source file coding', () => {
  it('carries the LifeLabs coding on type and category, no security label, and pdf content', async () => {
    const resource = await mintSourceFile(new TextEncoder().encode('%PDF-1.7\ntest'))

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

  it('mints a resource that reads back as its own source file, bytes and name recovered', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\n%\xff\xfa\nround-trip')
    const resource = await mintSourceFile(bytes, 'my-report.pdf')

    const back = await Effect.runPromise(
      Schema.decode(PickedFile.FromDocumentReference)(resource).pipe(
        Effect.provideService(PickedFile.Format, lifeLabsPdfImporter.sourceFileFormat)
      )
    )
    expect(back.fileName).toBe('my-report.pdf')
    expect(back.bytes).toEqual(bytes)
  })
})
