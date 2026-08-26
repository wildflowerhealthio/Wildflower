import { Effect, type Either, type ParseResult } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { Patient } from 'fhir-r4/resources'
import type { HttpResponse } from 'http-extraction-fundamentals'
import { makeHttpResponse } from 'http-extraction-fundamentals/test-helpers'

import { PatientEntity } from './patient-entity.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

const makeResponse = (body: string): HttpResponse.HttpResponse =>
  makeHttpResponse({
    url: 'https://example.com/Patient/1',
    headers: [['content-type', 'application/fhir+json']],
    body,
  })

/**
 * Build the WebView JSON-viewer wrapper around a raw FHIR JSON
 * payload. Mobile WebViews render `application/json` responses by
 * dropping the bytes inside a `<pre>` element with HTML entities
 * escaped (`<` → `&lt;`, `&` → `&amp;`); `PatientEntity.parse`
 * (via `extractJson`) strips this wrapper before decoding.
 */
const wrappedHtml = (rawJson: string): string => {
  const escaped = rawJson.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<html><body><pre style="word-wrap: break-word;">${escaped}</pre></body></html>`
}

/** Run `parse` (now Effect-returning) and convert to an Either for the `expectRight/LeftToEqual` helpers. */
const runParse = (
  r: HttpResponse.HttpResponse
): Either.Either<readonly (typeof Patient.Schema.Type)[], ParseResult.ParseError> =>
  Effect.runSync(Effect.either(PatientEntity.parse(r)))

describe('PatientEntity', () => {
  describe('isFoundAt', () => {
    it.each([
      { url: 'https://r4.smarthealthit.org/Patient/123', match: true },
      { url: 'https://example.com/Patient/abc', match: true },
      // New: ?-query terminator counts as a match (the production
      // URL is `…/Patient/<id>?_format=json`).
      { url: 'https://example.com/Patient/abc?_format=json', match: true },
      // Base-path-mounted FHIR servers match (issue #376).
      { url: 'https://hapi.fhir.org/baseR4/Patient/123', match: true },
      { url: 'https://example.com/Observation/456', match: false },
      // Trailing slash: not a match — the `(?:\?|$)` boundary excludes
      // `/_history` and other subresource paths.
      { url: 'https://example.com/Patient/123/', match: false },
      { url: 'https://example.com/Patient/123/_history', match: false },
    ])('returns $match for "$url"', ({ url, match }) => {
      expect(PatientEntity.isFoundAt(url)).toBe(match)
    })
  })

  describe('parse', () => {
    it('parses a minimal valid Patient JSON into a single-resource array', () => {
      expectRightToEqual(
        runParse(makeResponse(JSON.stringify({ resourceType: 'Patient', id: '42' }))),
        [expect.objectContaining({ id: '42' })]
      )
    })

    it('parses a Patient with name and gender', () => {
      expectRightToEqual(
        runParse(
          makeResponse(
            JSON.stringify({
              resourceType: 'Patient',
              id: '42',
              gender: 'male',
              name: [{ given: ['John'], family: 'Doe' }],
            })
          )
        ),
        [expect.objectContaining({ id: '42', gender: 'male' })]
      )
    })

    it('parses a Patient JSON wrapped in the WebView JSON-viewer HTML envelope', () => {
      const raw = JSON.stringify({ resourceType: 'Patient', id: '99' })
      expectRightToEqual(runParse(makeResponse(wrappedHtml(raw))), [
        expect.objectContaining({ id: '99' }),
      ])
    })

    it('fails with ParseError for malformed JSON', () => {
      expectLeftToEqual(
        runParse(makeResponse('{ not valid json }')),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    })

    it('never throws on arbitrary JSON strings', () => {
      fc.assert(
        fc.property(fc.json(), (json) => {
          const result = Effect.runSync(Effect.either(PatientEntity.parse(makeResponse(json))))
          expect(['Right', 'Left']).toContain(result._tag)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})
