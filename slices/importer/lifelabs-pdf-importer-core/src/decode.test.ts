import { Effect, Either, ParseResult } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { decodeLifeLabsPdfDocument } from './decode.ts'
import { arbitrary as reportArbitrary } from './entities/report-arbitrary.ts'
import { LIFELABS_SYSTEM } from './source-system.ts'
import { layoutDocument } from './test-helpers.ts'

/**
 * `decodeLifeLabsPdfDocument` is the pure "positioned-text document ↦
 * labeled FHIR resources" leg of the LifeLabs importer's `decode`. The outer
 * `decodeLifeLabsPdf(pdfBytes, ...)` wraps this with pdfjs extraction; that
 * seam is untested-by-design (see the anonymizer's PDF descriptor), so the
 * property tests here drive `decodeLifeLabsPdfDocument` directly against
 * `layoutDocument`'s printed inverse.
 */

const SETTINGS = { timeZone: 'America/Vancouver' }

describe('decodeLifeLabsPdfDocument', () => {
  it('property: a positioned-text document with LifeLabs reports decodes to labeled FHIR resources', () => {
    fc.assert(
      fc.property(fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }), (reports) => {
        const document = layoutDocument(reports)

        const labeled = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))

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

        const labeled = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))

        for (const item of labeled) {
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

        const labeled = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))

        for (const item of labeled) {
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
