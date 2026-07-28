import { Effect, type Either, type ParseResult } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { Response } from 'collector-fundamentals/model'
import { makeRemoteResponse } from 'collector-fundamentals/test-helpers'
import type { Observation } from 'fhir-r4/resources'

import { ObservationListEntity } from './observation-list-entity.ts'
import { PatientEntity } from './patient-entity.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

const makeResponse = (body: string): Response.RemoteResponse =>
  makeRemoteResponse({
    url: 'https://example.com/Observation?_count=1',
    headers: [['content-type', 'application/fhir+json']],
    body,
  })

/**
 * Build the WebView JSON-viewer wrapper around a raw FHIR JSON
 * payload (see the sibling `patient-entity.test.ts` for the full
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
  r: Response.RemoteResponse
): Promise<Either.Either<readonly (typeof Observation.Schema.Type)[], ParseResult.ParseError>> =>
  Effect.runPromise(Effect.either(ObservationListEntity.parse(r)))

/** The shape every re-keyed id from this collector takes. */
const DERIVED_ID = /^fhir-r4-[0-9a-f]{32}$/

/** The resources of a parse that was expected to succeed. */
const parsedResources = async (
  r: Response.RemoteResponse
): Promise<readonly (typeof Observation.Schema.Type)[]> => {
  const result = await runParse(r)
  if (result._tag !== 'Right') throw new Error('expected a successful parse')
  return result.right
}

describe('ObservationListEntity', () => {
  describe('isFoundAt', () => {
    it.each([
      // The exact production-shaped URL asked about: HAPI serves under a
      // base path (`/baseR4`), which `UrlMatch` now tolerates (issue #376).
      {
        url: 'https://hapi.fhir.org/baseR4/Observation?subject%3APatient=testmartin&_count=250&_format=json',
        match: true,
      },
      // No base path: `Observation` is the first path segment → matches.
      { url: 'https://r4.smarthealthit.org/Observation?subject=x', match: true },
      { url: 'https://hapi.fhir.org/Observation?_count=250&_format=json', match: true },
      // Deeper base path (Epic-style) still matches.
      {
        url: 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/Observation?patient=1',
        match: true,
      },
      // `mustHaveQuery`: a bare list URL with no query is NOT a match…
      { url: 'https://example.com/Observation', match: false },
      { url: 'https://example.com/baseR4/Observation', match: false },
      // …and the single-resource URL stays disjoint (that's ObservationEntity),
      // even under a base path.
      { url: 'https://example.com/Observation/123', match: false },
      { url: 'https://example.com/Observation/123?_format=json', match: false },
      { url: 'https://example.com/baseR4/Observation/123', match: false },
      { url: 'https://example.com/Patient?name=x', match: false },
    ])('returns $match for "$url"', ({ url, match }) => {
      expect(ObservationListEntity.isFoundAt(url)).toBe(match)
    })
  })

  describe('parse', () => {
    it('parses a Bundle of Observations into an array of resources', async () => {
      // Act
      const observations = await parsedResources(
        makeResponse(JSON.stringify(bundle(observation('1'), observation('2'))))
      )

      // Assert
      expect(observations).toHaveLength(2)
      for (const resource of observations) expect(resource.id).toMatch(DERIVED_ID)
    })

    it('re-keys each Observation distinctly and records the server id', async () => {
      // Act
      const observations = await parsedResources(
        makeResponse(JSON.stringify(bundle(observation('1'), observation('2'))))
      )

      // Assert
      expect(new Set(observations.map((resource) => resource.id)).size).toBe(2)
      expect(observations.map((resource) => resource.identifier)).toEqual([
        [expect.objectContaining({ value: '1' })],
        [expect.objectContaining({ value: '2' })],
      ])
    })

    it('rewrites a subject reference to the id the Patient entity derives', async () => {
      // A list response and a `Patient` response from one server reduce to the
      // same service base, which is the whole reason the link survives.
      const withSubject = {
        ...observation('1'),
        subject: { reference: 'Patient/42' },
      }
      const observations = await parsedResources(makeResponse(JSON.stringify(bundle(withSubject))))
      const patients = await Effect.runPromise(
        PatientEntity.parse(
          makeRemoteResponse({
            url: 'https://example.com/Patient/42',
            body: JSON.stringify({ resourceType: 'Patient', id: '42' }),
          })
        )
      )
      // Assert
      expect(observations[0]?.subject?.reference).toBe(`Patient/${patients[0]?.id}`)
    })

    it('returns an empty array for a Bundle with no entries', async () => {
      expectRightToEqual(
        await runParse(makeResponse(JSON.stringify({ resourceType: 'Bundle', type: 'searchset' }))),
        []
      )
    })

    it('drops entries with no `resource` (e.g. search-outcome/request-only entries)', async () => {
      // Act
      const observations = await parsedResources(
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
      )

      // Assert
      expect(observations.map((resource) => resource.identifier)).toEqual([
        [expect.objectContaining({ value: '1' })],
      ])
    })

    it('keeps an Observation missing `status`, defaulting it to `unknown` (real HAPI data)', async () => {
      // HAPI's public sandbox returns hand-entered Observations that omit the
      // FHIR-required `status`. Before the schema leniency this failed the
      // ENTIRE page decode; now the entry survives with status defaulted.
      const { status: _dropped, ...noStatus } = observation('bad')

      // Act
      const observations = await parsedResources(
        makeResponse(JSON.stringify(bundle(observation('1'), noStatus)))
      )

      // Assert
      expect(observations.map((resource) => resource.status)).toEqual(['final', 'unknown'])
    })

    it('still fails the decode when an entry has a present-but-invalid `status`', async () => {
      // Only absence is rescued — a present, unrecognized status is a genuine
      // wire error and must not be silently coerced.
      expectLeftToEqual(
        await runParse(
          makeResponse(JSON.stringify(bundle({ ...observation('x'), status: 'bogus' })))
        ),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    })

    it('parses a Bundle wrapped in the WebView JSON-viewer HTML envelope', async () => {
      // Arrange
      const raw = JSON.stringify(bundle(observation('99')))

      // Act
      const observations = await parsedResources(makeResponse(wrappedHtml(raw)))

      // Assert
      expect(observations.map((resource) => resource.identifier)).toEqual([
        [expect.objectContaining({ value: '99' })],
      ])
    })

    it('fails with ParseError for malformed JSON', async () => {
      expectLeftToEqual(
        await runParse(makeResponse('{ not valid json }')),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    })

    it('never throws on arbitrary JSON strings', async () => {
      await fc.assert(
        fc.asyncProperty(fc.json(), async (json) => {
          const result = await runParse(makeResponse(json))
          expect(['Right', 'Left']).toContain(result._tag)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})
