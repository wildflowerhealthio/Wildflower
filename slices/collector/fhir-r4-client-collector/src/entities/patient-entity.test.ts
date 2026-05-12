// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers (`expect.objectContaining`, `expect.stringContaining`, etc.) are typed as `any`; composing them inside `objectContaining` is the intended idiom

import { Effect } from 'effect'
import fc from 'fast-check'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { Response } from 'collector-core/model'

import { PatientEntity } from './patient-entity.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

const encoder = new TextEncoder()

const makeResponse = (body: string): Response.RemoteResponse => {
  const r = new Response.RemoteResponse('https://example.com/Patient/1', 200, 'OK', {
    'content-type': 'application/fhir+json',
  })
  r.appendChunk(encoder.encode(body))
  return r
}

/** Run `parse` (now Effect-returning) and convert to an Either for the `expectRight/LeftToEqual` helpers. */
const runParse = (r: Response.RemoteResponse): unknown =>
  Effect.runSync(Effect.either(PatientEntity.parse(r)))

describe('PatientEntity', () => {
  describe('isFoundAt', () => {
    it.each([
      { url: 'https://r4.smarthealthit.org/Patient/123', match: true },
      { url: 'https://example.com/Patient/abc', match: true },
      // New: ?-query terminator counts as a match (the production
      // URL is `…/Patient/<id>?_format=json`).
      { url: 'https://example.com/Patient/abc?_format=json', match: true },
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
    it('parses a minimal valid Patient JSON into one resource + one Observation link', () => {
      expectRightToEqual(
        runParse(makeResponse(JSON.stringify({ resourceType: 'Patient', id: '42' }))),
        expect.objectContaining({
          resources: [expect.objectContaining({ id: '42' })],
          links: [
            expect.objectContaining({
              _tag: 'Open',
              href: expect.stringContaining('Observation'),
            }),
          ],
        })
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
        expect.objectContaining({
          resources: [expect.objectContaining({ id: '42', gender: 'male' })],
        })
      )
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
        })
      )
    })

    it('URL-encodes the Observation query link parameter', () => {
      const body = JSON.stringify({ resourceType: 'Patient', id: 'abc-123.def' })
      expectRightToEqual(
        runParse(makeResponse(body)),
        expect.objectContaining({
          links: [
            expect.objectContaining({
              href: expect.stringContaining(encodeURIComponent('abc-123.def')),
            }),
          ],
        })
      )
    })
  })
})
