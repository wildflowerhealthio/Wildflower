import { Effect, type Either, Option, type ParseResult } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { Observation } from 'fhir-r4/resources'
import { type HttpMethod, type HttpResponse, Specificity } from 'http-extraction-fundamentals'
import { makeHttpResponse } from 'http-extraction-fundamentals/test-helpers'

import { ObservationListResponseKind } from './observation-list-response-kind.ts'

const GET: Option.Option<HttpMethod> = Option.some('GET')
const POST: Option.Option<HttpMethod> = Option.some('POST')
const NO_METHOD: Option.Option<HttpMethod> = Option.none()

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

const makeResponse = (body: string): HttpResponse.HttpResponse =>
  makeHttpResponse({
    url: 'https://example.com/Observation?_count=1',
    headers: [['content-type', 'application/fhir+json']],
    body,
  })

/**
 * Build the WebView JSON-viewer wrapper around a raw FHIR JSON
 * payload (see the sibling `patient-response-kind.test.ts` for the full
 * rationale): mobile WebViews render `application/json` inside an
 * HTML-escaped `<pre>`, which `extractJson` strips before decoding.
 */
const wrappedHtml = (rawJson: string): string => {
  const escaped = rawJson.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<html><body><pre style="word-wrap: break-word;">${escaped}</pre></body></html>`
}

/** A minimal FHIR `Observation` resource (required: resourceType, status, code). */
const observation = (id: string): Record<string, unknown> => ({
  resourceType: 'Observation',
  id,
  status: 'final',
  code: { text: 'Heart rate' },
})

/** A FHIR `Bundle` (searchset) wrapping the given entry resources. */
const bundle = (...resources: readonly unknown[]): Record<string, unknown> => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
})

const runParse = (
  r: HttpResponse.HttpResponse
): Either.Either<readonly (typeof Observation.Schema.Type)[], ParseResult.ParseError> =>
  Effect.runSync(Effect.either(ObservationListResponseKind.parse(r)))

describe('ObservationListResponseKind', () => {
  describe('tryRecognize', () => {
    it.each([
      // The exact production-shaped URL asked about: HAPI serves under a
      // base path (`/baseR4`), which `UrlMatch` tolerates (issue #376), and the
      // base path is recovered as the root (absorbing the per-URL root cases).
      {
        url: 'https://hapi.fhir.org/baseR4/Observation?subject%3APatient=testmartin&_count=250&_format=json',
        root: 'https://hapi.fhir.org/baseR4',
      },
      // No base path: `Observation` is the first path segment → matches.
      {
        url: 'https://r4.smarthealthit.org/Observation?subject=x',
        root: 'https://r4.smarthealthit.org',
      },
      {
        url: 'https://hapi.fhir.org/Observation?_count=250&_format=json',
        root: 'https://hapi.fhir.org',
      },
      // Deeper base path (Epic-style) still matches and recovers its full root.
      {
        url: 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/Observation?patient=1',
        root: 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4',
      },
    ])('recognizes "$url" under root "$root"', ({ url, root }) => {
      expect(ObservationListResponseKind.tryRecognize(url, GET)).toStrictEqual(
        Option.some({ specificity: Specificity.PROTOCOL, source: { system: root, baseUrl: root } })
      )
    })

    it.each([
      { method: POST, label: 'POST' },
      { method: NO_METHOD, label: 'Option.none()' },
    ])('does not claim under method $label', ({ method }) => {
      expect(
        ObservationListResponseKind.tryRecognize(
          'https://hapi.fhir.org/baseR4/Observation?subject=x',
          method
        )
      ).toStrictEqual(Option.none())
    })

    it.each([
      // `mustHaveQuery`: a bare list URL with no query is NOT a match…
      { url: 'https://example.com/Observation' },
      { url: 'https://example.com/baseR4/Observation' },
      // …and the single-resource URL stays disjoint (that's ObservationResponseKind),
      // even under a base path.
      { url: 'https://example.com/Observation/123' },
      { url: 'https://example.com/Observation/123?_format=json' },
      { url: 'https://example.com/baseR4/Observation/123' },
      { url: 'https://example.com/Patient?name=x' },
    ])('does not claim "$url"', ({ url }) => {
      expect(ObservationListResponseKind.tryRecognize(url, GET)).toStrictEqual(Option.none())
    })
  })

  describe('parse', () => {
    it('parses a Bundle of Observations into an array of resources', () => {
      expectRightToEqual(
        runParse(makeResponse(JSON.stringify(bundle(observation('1'), observation('2'))))),
        [expect.objectContaining({ id: '1' }), expect.objectContaining({ id: '2' })]
      )
    })

    it('returns an empty array for a Bundle with no entries', () => {
      expectRightToEqual(
        runParse(makeResponse(JSON.stringify({ resourceType: 'Bundle', type: 'searchset' }))),
        []
      )
    })

    it('drops entries with no `resource` (e.g. search-outcome/request-only entries)', () => {
      expectRightToEqual(
        runParse(
          makeResponse(
            JSON.stringify({
              resourceType: 'Bundle',
              type: 'searchset',
              entry: [
                { resource: observation('1') },
                // A resource-less entry (FHIR allows search-outcome or
                // request/response-only entries); `OrNullAsOptional` decodes
                // it fine and `.filter(isObservation)` drops it here.
                {
                  fullUrl: 'https://example.com/Observation?_count=1',
                  search: { mode: 'outcome' },
                },
              ],
            })
          )
        ),
        [expect.objectContaining({ id: '1' })]
      )
    })

    it('keeps an Observation missing `status`, defaulting it to `unknown` (real HAPI data)', () => {
      // HAPI's public sandbox returns hand-entered Observations that omit the
      // FHIR-required `status`. Before the schema leniency this failed the
      // ENTIRE page decode; now the entry survives with status defaulted.
      const { status: _dropped, ...noStatus } = observation('bad')
      expectRightToEqual(
        runParse(makeResponse(JSON.stringify(bundle(observation('1'), noStatus)))),
        [
          expect.objectContaining({ id: '1', status: 'final' }),
          expect.objectContaining({ id: 'bad', status: 'unknown' }),
        ]
      )
    })

    it('still fails the decode when an entry has a present-but-invalid `status`', () => {
      // Only absence is rescued — a present, unrecognized status is a genuine
      // wire error and must not be silently coerced.
      expectLeftToEqual(
        runParse(makeResponse(JSON.stringify(bundle({ ...observation('x'), status: 'bogus' })))),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    })

    it('parses a Bundle wrapped in the WebView JSON-viewer HTML envelope', () => {
      const raw = JSON.stringify(bundle(observation('99')))
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
            Effect.either(ObservationListResponseKind.parse(makeResponse(json)))
          )
          expect(['Right', 'Left']).toContain(result._tag)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})
