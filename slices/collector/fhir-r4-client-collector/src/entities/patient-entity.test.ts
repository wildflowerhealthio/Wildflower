// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers (`expect.objectContaining`, `expect.stringContaining`, etc.) are typed as `any`; composing them inside `objectContaining` is the intended idiom

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

describe('PatientEntity', () => {
  describe('isFoundAt', () => {
    it.each([
      { url: 'https://r4.smarthealthit.org/Patient/123', match: true },
      { url: 'https://example.com/Patient/abc', match: true },
      { url: 'https://example.com/Observation/456', match: false },
      { url: 'https://example.com/Patient/123/', match: false },
    ])('returns $match for "$url"', ({ url, match }) => {
      expect(PatientEntity.isFoundAt(url)).toBe(match)
    })
  })

  describe('parse', () => {
    it('parses a minimal valid Patient JSON into one resource + one Observation link', () => {
      expectRightToEqual(
        PatientEntity.parse(makeResponse(JSON.stringify({ resourceType: 'Patient', id: '42' }))),
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
        PatientEntity.parse(
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

    it('returns Left for malformed JSON', () => {
      expectLeftToEqual(
        PatientEntity.parse(makeResponse('{ not valid json }')),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    })

    it('never throws on arbitrary JSON strings', () => {
      fc.assert(
        fc.property(fc.json(), (json) => {
          expect(['Right', 'Left']).toContain(PatientEntity.parse(makeResponse(json))._tag)
        })
      )
    })

    it('encodes special characters in the Observation query link', () => {
      const body = JSON.stringify({ resourceType: 'Patient', id: 'special&chars=yes' })
      expectRightToEqual(
        PatientEntity.parse(makeResponse(body)),
        expect.objectContaining({
          links: [
            expect.objectContaining({
              href: expect.stringContaining(encodeURIComponent('special&chars=yes')),
            }),
          ],
        })
      )
    })
  })
})
