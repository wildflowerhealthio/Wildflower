import { Effect, type Either, type ParseResult } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { Response } from 'collector-fundamentals/model'
import type { Patient } from 'fhir-r4/resources'

import { ProfileEntity } from './profile-entity.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

const encoder = new TextEncoder()

const makeResponse = (body: string): Response.RemoteResponse => {
  const r = new Response.RemoteResponse(
    'https://mypharmacy.shoppersdrugmart.ca/api/profile/getProfile/',
    200,
    'OK',
    [['content-type', 'application/json']]
  )
  r.appendChunk(encoder.encode(body))
  return r
}

const runParse = (
  r: Response.RemoteResponse
): Either.Either<readonly (typeof Patient.Schema.Type)[], ParseResult.ParseError> =>
  Effect.runSync(Effect.either(ProfileEntity.parse(r)))

/** A representative production-shaped profile payload. */
const profileJson = JSON.stringify({
  pcId: 'pc-uuid-1',
  profile: {
    address: {
      streetAddress1: '123 Main St',
      streetAddress2: 'Unit 4',
      city: 'Toronto',
      province: 'ON',
      postalCode: 'M1M1M1',
      country: 'CA',
    },
    bannerName: 'SHOPPERS',
    dateOfBirth: '1990-05-15',
    email: 'member@example.com',
    firstName: 'Jordan',
    lastName: 'Rivera',
    phone: '4165551234',
  },
})

describe('ProfileEntity', () => {
  describe('isFoundAt', () => {
    it.each([
      { url: 'https://mypharmacy.shoppersdrugmart.ca/api/profile/getProfile/', match: true },
      // Without the trailing slash still matches.
      { url: 'https://mypharmacy.shoppersdrugmart.ca/api/profile/getProfile', match: true },
      // Query string after the slash still matches.
      { url: 'https://mypharmacy.shoppersdrugmart.ca/api/profile/getProfile/?v=2', match: true },
      // Disjoint from the prescription-status pattern.
      {
        url: 'https://mypharmacy.shoppersdrugmart.ca/api/v1/prescriptions/rx-1/prescription-status',
        match: false,
      },
      { url: 'https://mypharmacy.shoppersdrugmart.ca/api/profile/updateProfile/', match: false },
    ])('returns $match for "$url"', ({ url, match }) => {
      expect(ProfileEntity.isFoundAt(url)).toBe(match)
    })
  })

  describe('parse', () => {
    it('synthesizes a Patient keyed by pcId with demographics', () => {
      expectRightToEqual(runParse(makeResponse(profileJson)), [
        expect.objectContaining({
          resourceType: 'Patient',
          id: 'pc-uuid-1',
        }),
      ])
    })

    it('records pcId as an identifier, and maps name / birthDate / telecom / address', () => {
      const result = Effect.runSync(ProfileEntity.parse(makeResponse(profileJson)))
      const [patient] = result
      expect(patient?.identifier).toEqual([
        expect.objectContaining({
          system: new URL('https://mypharmacy.shoppersdrugmart.ca/fhir/identifier/pc-id'),
          value: 'pc-uuid-1',
        }),
      ])
      expect(patient?.name).toEqual([
        expect.objectContaining({ family: 'Rivera', given: ['Jordan'] }),
      ])
      expect(patient?.telecom).toEqual([
        expect.objectContaining({ system: 'email', value: 'member@example.com' }),
        expect.objectContaining({ system: 'phone', value: '4165551234' }),
      ])
      expect(patient?.address).toEqual([
        expect.objectContaining({
          line: ['123 Main St', 'Unit 4'],
          city: 'Toronto',
          state: 'ON',
          postalCode: 'M1M1M1',
          country: 'CA',
        }),
      ])
      // `birthDate` decodes to a TimelessDate; its ISO form is the source date.
      expect(patient?.birthDate).toBeDefined()
    })

    it('synthesizes a bare Patient from just pcId when profile is absent', () => {
      expectRightToEqual(runParse(makeResponse(JSON.stringify({ pcId: 'pc-only' }))), [
        expect.objectContaining({ resourceType: 'Patient', id: 'pc-only' }),
      ])
    })

    it('drops a non-date dateOfBirth rather than failing the decode', () => {
      const json = JSON.stringify({ pcId: 'pc-2', profile: { dateOfBirth: 'not-a-date' } })
      const result = Effect.runSync(ProfileEntity.parse(makeResponse(json)))
      expect(result[0]?.birthDate).toBeNull()
    })

    it('parses a profile wrapped in the WebView JSON-viewer HTML envelope', () => {
      const escaped = profileJson.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const wrapped = `<html><body><pre>${escaped}</pre></body></html>`
      expectRightToEqual(runParse(makeResponse(wrapped)), [
        expect.objectContaining({ id: 'pc-uuid-1' }),
      ])
    })

    it('fails with ParseError when the required pcId is missing', () => {
      expectLeftToEqual(
        runParse(makeResponse(JSON.stringify({ profile: { firstName: 'X' } }))),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    })

    it('never throws on arbitrary JSON strings', () => {
      fc.assert(
        fc.property(fc.json(), (json) => {
          const result = Effect.runSync(Effect.either(ProfileEntity.parse(makeResponse(json))))
          expect(['Right', 'Left']).toContain(result._tag)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})
