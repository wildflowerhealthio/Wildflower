import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import {
  DecodedFile,
  DecodedFileSet,
  type DecodeFunction,
  Referent,
} from '@wildflowerhealthio/importer-fundamentals'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { PositionedTextExtractor, UnreadablePdf } from '@wildflowerhealthio/positioned-text'
import { Effect, Either, Layer, Option, ParseResult } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { decodeLifeLabsPdf, decodeLifeLabsPdfDocument } from './decode.ts'
import { arbitrary as reportArbitrary } from './entities/report-arbitrary.ts'
import { patientOriginalId, practitionerOriginalId } from './fhir/to-fhir.ts'
import { LIFELABS_SYSTEM } from './source-system.ts'
import { reportSectionTitle } from './synthesis.ts'
import { layoutDocument } from './test-helpers.ts'

/**
 * `decodeLifeLabsPdfDocument` is the "positioned-text document ↦ per-report
 * sections of labeled FHIR resources" leg of the LifeLabs importer's
 * `decode`. The outer `decodeLifeLabsPdf(file, ...)` runs it on what the
 * `PositionedTextExtractor` read off the bytes; the property tests here drive
 * `decodeLifeLabsPdfDocument` directly against `layoutDocument`'s printed
 * inverse, and `decodeLifeLabsPdf` under a fake extractor.
 */

const SETTINGS = { timeZone: 'America/Vancouver' }

/** Every record of a decode, detached. */
const entriesOf = (decoded: DecodeFunction.FileSetDecode): readonly DecodedFileSet.Entry[] =>
  decoded.sections.flatMap(({ entries }) => entries)

describe('decodeLifeLabsPdfDocument', () => {
  it('property: a document with LifeLabs reports decodes to one titled section per report', () => {
    fc.assert(
      fc.property(fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }), (reports) => {
        const document = layoutDocument(reports)

        const decoded = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))

        expect(decoded.notes).toEqual([])
        expect(decoded.sections.map((section) => section.title)).toEqual(
          reports.map(reportSectionTitle)
        )
        expect(entriesOf(decoded).length).toBeGreaterThan(0)
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('property: each entry fullUrl is {resourceType}/{source id}, and its row titled by the reference it is written under', () => {
    fc.assert(
      fc.property(fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }), (reports) => {
        const document = layoutDocument(reports)

        const decoded = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))

        const entries = entriesOf(decoded)
        expect(entries.map(({ fullUrl }) => fullUrl)).toEqual(
          entries.map(({ resource }) =>
            Option.match(DetachedResource.keyOf(resource), {
              onSome: ({ value }) => `${resource.resourceType}/${value}`,
              onNone: () => 'keyless',
            })
          )
        )
        const written = DecodedFile.resources(DecodedFileSet.adopt(decoded))
        expect(written.map(({ title }) => title)).toEqual(
          written.map(({ resource }) => `${resource.resourceType}/${resource.id}`)
        )
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('property: each record is detached, keyed by the id the synthesis gave it in the LifeLabs system', () => {
    fc.assert(
      fc.property(fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }), (reports) => {
        const document = layoutDocument(reports)

        const decoded = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))

        for (const { resource } of entriesOf(decoded)) {
          expect(resource.id).toBeNull()
          expect(Option.map(DetachedResource.keyOf(resource), ({ system }) => system)).toEqual(
            Option.some(LIFELABS_SYSTEM)
          )
        }
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('property: each record adopts under the LifeLabs system', () => {
    fc.assert(
      fc.property(fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }), (reports) => {
        const document = layoutDocument(reports)

        const decoded = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))

        for (const { resource } of DecodedFile.resources(DecodedFileSet.adopt(decoded))) {
          expect(resource.id).toMatch(/^wf-[0-9a-f]{32}$/)
          if (resource.resourceType !== 'Binary') {
            expect(String(resource.identifier[0]?.system)).toBe(LIFELABS_SYSTEM)
          }
        }
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('property: its referents are each Patient and each provider it names, with their resources', () => {
    fc.assert(
      fc.property(fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }), (reports) => {
        const document = layoutDocument(reports)
        const providerNames = reports
          .flatMap((report) => [report.orderedBy, ...report.copyTo])
          .map((name) => name.trim())
          .filter((name) => name !== '')
        const expected = [
          ...new Set(reports.map((report) => `Patient|${patientOriginalId(report.patient)}`)),
          ...new Set(providerNames.map((name) => `Practitioner|${practitionerOriginalId(name)}`)),
        ]

        const decoded = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))
        const referents = Effect.runSync(Referent.discover([DecodedFileSet.adopt(decoded)]))

        for (const referent of referents) {
          expect(referent._tag).toBe('AsResource')
          expect(referent.logicalReference.identifier.system.href).toBe(LIFELABS_SYSTEM)
        }
        expect(
          referents
            .map(
              ({ logicalReference }) =>
                `${logicalReference.type}|${logicalReference.identifier.value}`
            )
            .toSorted()
        ).toEqual(expected.toSorted())
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('fails with a ParseError for a document with no LifeLabs report markers', () => {
    // A well-formed positioned-text document with no page runs — no `Lab No`,
    // no grid heading — is rejected as an unrecognized LifeLabs document.
    const document = {
      format: 'wildflower-positioned-text' as const,
      version: 1 as const,
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          runs: [{ text: 'hello', x: 100, y: 100, width: 20, fontSize: 10 }],
        },
      ],
    }

    const outcome = Effect.runSync(Effect.either(decodeLifeLabsPdfDocument(document, SETTINGS)))

    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) expect(ParseResult.isParseError(outcome.left)).toBe(true)
  })

  it('fails with a ParseError for an invalid time zone', () => {
    const document = layoutDocument([])
    const outcome = Effect.runSync(
      Effect.either(decodeLifeLabsPdfDocument(document, { timeZone: 'Not/A_Zone' }))
    )
    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) expect(ParseResult.isParseError(outcome.left)).toBe(true)
  })
})

describe('reportSectionTitle', () => {
  it('should join the Lab No and date of service when both are printed', () => {
    fc.assert(
      fc.property(reportArbitrary, (report) => {
        const title = reportSectionTitle(report)

        if (report.labNo.trim() !== '' && report.dateOfService.trim() !== '') {
          expect(title).toBe(`Lab No ${report.labNo.trim()} — ${report.dateOfService.trim()}`)
        } else {
          expect(title.length).toBeGreaterThan(0)
        }
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should fall back to a generic label when the report masks both fields', () => {
    fc.assert(
      fc.property(reportArbitrary, (report) => {
        const masked = { ...report, labNo: '', dateOfService: '' }

        expect(reportSectionTitle(masked)).toBe('LifeLabs report')
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })
})

describe('decodeLifeLabsPdf', () => {
  const file = { fileName: 'Reports.pdf', bytes: new TextEncoder().encode('%PDF-1.7 stand-in') }

  it('property: decodes the document the extractor reads off the bytes', () => {
    fc.assert(
      fc.property(fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }), (reports) => {
        const document = layoutDocument(reports)
        const extractor = Layer.succeed(PositionedTextExtractor, {
          extract: (bytes) =>
            bytes === file.bytes
              ? Effect.succeed(document)
              : Effect.fail(new UnreadablePdf({ cause: 'other bytes' })),
        })

        const decoded = Effect.runSync(
          decodeLifeLabsPdf(file, SETTINGS).pipe(Effect.provide(extractor))
        )

        expect(decoded).toEqual(Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS)))
      }),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })

  it('fails with a ParseError carrying the message of a PDF the extractor cannot open', () => {
    const extractor = Layer.succeed(PositionedTextExtractor, {
      extract: () => Effect.fail(new UnreadablePdf({ cause: new Error('Invalid PDF structure.') })),
    })

    const result = Effect.runSync(
      Effect.either(decodeLifeLabsPdf(file, SETTINGS).pipe(Effect.provide(extractor)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true)
      expect(result.left.message).toContain('Invalid PDF structure.')
    }
  })
})
