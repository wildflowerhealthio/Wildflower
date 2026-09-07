import { Effect, type Either, Option, type ParseResult } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { Patient } from 'fhir-r4/resources'
import { type HttpMethod, type HttpResponse, Specificity } from 'http-extraction-fundamentals'
import { makeHttpResponse } from 'http-extraction-fundamentals/test-helpers'

import { PatientResponseKind } from './patient-response-kind.ts'

const GET: Option.Option<HttpMethod> = Option.some('GET')
const POST: Option.Option<HttpMethod> = Option.some('POST')
const NO_METHOD: Option.Option<HttpMethod> = Option.none()

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
 * escaped (`<` → `&lt;`, `&` → `&amp;`); `PatientResponseKind.parse`
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
  Effect.runSync(Effect.either(PatientResponseKind.parse(r)))

describe('PatientResponseKind', () => {
  describe('tryRecognize', () => {
    it.each([
      // A recognized URL yields its own root as the source (system === baseUrl),
      // absorbing the per-URL root-capture cases.
      { url: 'https://r4.smarthealthit.org/Patient/123', root: 'https://r4.smarthealthit.org' },
      { url: 'https://example.com/Patient/abc', root: 'https://example.com' },
      // ?-query terminator counts (the production URL is `…/Patient/<id>?_format=json`).
      { url: 'https://example.com/Patient/abc?_format=json', root: 'https://example.com' },
      // Base-path-mounted FHIR servers recover their base path as the root (#376).
      { url: 'https://hapi.fhir.org/baseR4/Patient/123', root: 'https://hapi.fhir.org/baseR4' },
      {
        url: 'https://ehr.example.com/interconnect-fhir-oauth/api/FHIR/R4/Patient/eXYZ',
        root: 'https://ehr.example.com/interconnect-fhir-oauth/api/FHIR/R4',
      },
    ])('recognizes "$url" under root "$root"', ({ url, root }) => {
      const recognized = PatientResponseKind.tryRecognize(url, GET)
      expect(recognized).toStrictEqual(
        Option.some({ specificity: Specificity.PROTOCOL, source: { system: root, baseUrl: root } })
      )
    })

    it.each([
      // The wrong verb never claims a Patient URL.
      { method: POST, label: 'POST' },
      // A HAR entry without a known method never claims either.
      { method: NO_METHOD, label: 'Option.none()' },
    ])('does not claim a Patient URL under method $label', ({ method }) => {
      expect(
        PatientResponseKind.tryRecognize('https://example.com/Patient/1', method)
      ).toStrictEqual(Option.none())
    })

    it.each([
      { url: 'https://example.com/Observation/456' },
      // Trailing slash / subresource paths are excluded by the `(?:\?|$)` boundary.
      { url: 'https://example.com/Patient/123/' },
      { url: 'https://example.com/Patient/123/_history' },
    ])('does not claim "$url"', ({ url }) => {
      expect(PatientResponseKind.tryRecognize(url, GET)).toStrictEqual(Option.none())
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
          const result = Effect.runSync(
            Effect.either(PatientResponseKind.parse(makeResponse(json)))
          )
          expect(['Right', 'Left']).toContain(result._tag)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})
