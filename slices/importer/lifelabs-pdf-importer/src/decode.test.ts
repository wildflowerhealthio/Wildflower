import { Effect, Either, ParseResult } from 'effect'
import * as fc from 'fast-check'
import { DecodedFile } from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { decodeLifeLabsPdfDocument, reportSectionTitle } from './decode.ts'
import { arbitrary as reportArbitrary } from './entities/report-arbitrary.ts'
import { LIFELABS_SYSTEM } from './source-system.ts'
import { layoutDocument } from './test-helpers.ts'

/**
 * `decodeLifeLabsPdfDocument` is the pure "positioned-text document ↦
 * per-report sections of labeled FHIR resources" leg of the LifeLabs
 * importer's `decode`. The outer `decodeLifeLabsPdf(file, ...)` wraps
 * this with pdfjs extraction; that seam is untested-by-design (see the
 * anonymizer's PDF descriptor), so the property tests here drive
 * `decodeLifeLabsPdfDocument` directly against `layoutDocument`'s printed
 * inverse.
 */

const SETTINGS = { timeZone: 'America/Vancouver' }

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
        const labeled = DecodedFile.resources(decoded)
        expect(labeled.length).toBeGreaterThan(0)
        for (const item of labeled) {
          expect(item).toHaveProperty('key')
          expect(item).toHaveProperty('title')
          expect(item).toHaveProperty('resource')
        }
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('property: key and title follow the {resourceType}/{id} format', () => {
    fc.assert(
      fc.property(fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }), (reports) => {
        const document = layoutDocument(reports)

        const decoded = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))

        for (const item of DecodedFile.resources(decoded)) {
          const type = item.resource.resourceType
          const id = item.resource.id
          expect(id).not.toBeNull()
          const expected = `${type}/${String(id)}`
          expect(item.key).toBe(expected)
          expect(item.title).toBe(expected)
        }
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('property: each resource has been adopted under the LifeLabs source system', () => {
    fc.assert(
      fc.property(fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }), (reports) => {
        const document = layoutDocument(reports)

        const decoded = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))

        for (const item of DecodedFile.resources(decoded)) {
          const resource = item.resource
          // Adopted resources receive a derived local id with the 'wf-' prefix
          expect(resource.id).toMatch(/^wf-[0-9a-f]{32}$/)
          // Non-Binary resources carry the source system in identifier[0]
          if (resource.resourceType !== 'Binary') {
            const identifier = resource.identifier[0]
            expect(identifier).toBeDefined()
            expect(String(identifier.system)).toBe(LIFELABS_SYSTEM)
          }
        }
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
