import { Effect, type Either, type ParseResult } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { Response } from 'collector-fundamentals/model'
import { makeRemoteResponse } from 'collector-fundamentals/test-helpers'
import type { Patient } from 'fhir-r4/resources'

import { PatientEntity } from './patient-entity.ts'

const { expectLeftToEqual } = utilityExpectations(expect)

const makeResponse = (body: string): Response.RemoteResponse =>
  makeRemoteResponse({
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

/** Run `parse` and convert to an Either for the `expectRight/LeftToEqual` helpers. */
const runParse = (
  r: Response.RemoteResponse
): Promise<Either.Either<readonly (typeof Patient.Schema.Type)[], ParseResult.ParseError>> =>
  Effect.runPromise(Effect.either(PatientEntity.parse(r)))

/** The shape every re-keyed id from this collector takes. */
const DERIVED_ID = /^fhir-r4-[0-9a-f]{32}$/

/** The resources of a parse that was expected to succeed. */
const parsedResources = async (
  r: Response.RemoteResponse
): Promise<readonly (typeof Patient.Schema.Type)[]> => {
  const result = await runParse(r)
  if (result._tag !== 'Right') throw new Error('expected a successful parse')
  return result.right
}

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
    it('parses a minimal valid Patient JSON into a single-resource array', async () => {
      // Act
      const patients = await parsedResources(
        makeResponse(JSON.stringify({ resourceType: 'Patient', id: '42' }))
      )

      // Assert
      expect(patients).toHaveLength(1)
      expect(patients[0]?.id).toMatch(DERIVED_ID)
    })

    it('records the server-assigned id as an identifier', async () => {
      // Arrange / Act — `Patient/42` on this server is not `Patient/42` on
      // another, so the stored id is derived, and the server's own is kept to
      // get back to it.
      const patients = await parsedResources(
        makeResponse(JSON.stringify({ resourceType: 'Patient', id: '42' }))
      )

      // Assert
      expect(patients[0]?.identifier).toEqual([
        expect.objectContaining({ system: new URL('https://example.com/'), value: '42' }),
      ])
    })

    it('parses a Patient with name and gender', async () => {
      // Act
      const patients = await parsedResources(
        makeResponse(
          JSON.stringify({
            resourceType: 'Patient',
            id: '42',
            gender: 'male',
            name: [{ given: ['John'], family: 'Doe' }],
          })
        )
      )

      // Assert
      expect(patients[0]?.gender).toBe('male')
      expect(patients[0]?.name[0]?.family).toBe('Doe')
    })

    it('parses a Patient JSON wrapped in the WebView JSON-viewer HTML envelope', async () => {
      // Arrange
      const raw = JSON.stringify({ resourceType: 'Patient', id: '99' })

      // Act
      const patients = await parsedResources(makeResponse(wrappedHtml(raw)))

      // Assert
      expect(patients[0]?.identifier).toEqual([expect.objectContaining({ value: '99' })])
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
