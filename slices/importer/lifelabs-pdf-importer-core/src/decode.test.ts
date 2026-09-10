import { Effect, Either, Option, ParseResult } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { decodeLifeLabsPdf, LIFELABS_PDF_URL_PREFIX, TIME_ZONE_HEADER } from './decode.ts'
import { arbitrary as reportArbitrary } from './entities/report-arbitrary.ts'
import { layoutDocument } from './test-helpers.ts'

const SETTINGS = { timeZone: 'America/Vancouver' }

describe('decodeLifeLabsPdf', () => {
  it('property: a positioned-text document decodes to one response carrying the file verbatim, under its name', () => {
    fc.assert(
      fc.property(
        fc.array(reportArbitrary, { maxLength: 2 }),
        fc.stringMatching(/^[A-Za-z0-9 _-]{1,20}\.pdf$/),
        (reports, fileName) => {
          const text = JSON.stringify(layoutDocument(reports, fileName))

          const inputs = Effect.runSync(decodeLifeLabsPdf(text, SETTINGS))

          expect(inputs).toHaveLength(1)
          const [input] = inputs
          expect(input?.url).toBe(`${LIFELABS_PDF_URL_PREFIX}${encodeURIComponent(fileName)}`)
          expect(input?.method).toEqual(Option.some('GET'))
          expect(input?.status).toBe(200)
          expect(input?.bodyAbsent).toBe(false)
          expect(new TextDecoder().decode(input?.body)).toBe(text)
          expect(input?.headers).toContainEqual([TIME_ZONE_HEADER, 'America/Vancouver'])
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('names the response after a default when the document carries no fileName', () => {
    const text = JSON.stringify({ format: 'wildflower-positioned-text', version: 1, pages: [] })

    const [input] = Effect.runSync(decodeLifeLabsPdf(text, SETTINGS))

    expect(input?.url).toBe(`${LIFELABS_PDF_URL_PREFIX}report.json`)
    expect(input?.id).toBe('lifelabs-pdf:report.json')
  })

  it('fails with a ParseError, not a throw, for text that is not a positioned-text document', () => {
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
})
