import { Effect, Either, ParseResult } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { decodeLifeLabsPdf } from './decode.ts'
import { arbitrary as reportArbitrary } from './entities/report-arbitrary.ts'
import { LIFELABS_SYSTEM } from './source-system.ts'
import { layoutDocument } from './test-helpers.ts'

const SETTINGS = { timeZone: 'America/Vancouver' }

describe('decodeLifeLabsPdf', () => {
  it('property: a positioned-text document with LifeLabs reports decodes to labeled FHIR resources', () => {
    fc.assert(
      fc.property(fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }), (reports) => {
        const text = JSON.stringify(layoutDocument(reports))

        const labeled = Effect.runSync(decodeLifeLabsPdf(text, SETTINGS))

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
        const text = JSON.stringify(layoutDocument(reports))

        const labeled = Effect.runSync(decodeLifeLabsPdf(text, SETTINGS))

        for (const item of labeled) {
          const type = item.resource.resourceType
          const id = item.resource.id
          const expected = `${type}/${id ?? '?'}`
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
        const text = JSON.stringify(layoutDocument(reports))

        const labeled = Effect.runSync(decodeLifeLabsPdf(text, SETTINGS))

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

  it('fails with a ParseError for text that is not a positioned-text document', () => {
    for (const text of [
      'not json',
      '{}',
      JSON.stringify({ format: 'har', version: 1, pages: [] }),
    ]) {
      const outcome = Effect.runSync(Effect.either(decodeLifeLabsPdf(text, SETTINGS)))
      expect(Either.isLeft(outcome)).toBe(true)
      if (Either.isLeft(outcome)) expect(ParseResult.isParseError(outcome.left)).toBe(true)
    }
  })

  it('fails with a ParseError for an invalid time zone', () => {
    const text = JSON.stringify(layoutDocument([]))
    const outcome = Effect.runSync(
      Effect.either(decodeLifeLabsPdf(text, { timeZone: 'Not/A_Zone' }))
    )
    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) expect(ParseResult.isParseError(outcome.left)).toBe(true)
  })
})
