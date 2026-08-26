import { makeRemoteResponse } from 'collector-fundamentals/test-helpers'
import { Effect, type Either, type ParseResult } from 'effect'
import * as fc from 'fast-check'
import type { Patient } from 'fhir-r4/resources'
import type { HttpResponse } from 'http-extraction-fundamentals'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import profileMe from '../fixtures/profile-me.json' with { type: 'json' }
import { ProfileEntity } from './profile-entity.ts'

const { expectLeftToEqual } = utilityExpectations(expect)

const PROFILE_URL = 'https://rexall-prd-tunnel.letsbewell.ca/enduser/profile/v2/me'

const makeResponse = (body: string, url = PROFILE_URL): HttpResponse.HttpResponse =>
  makeRemoteResponse({ url, body })

const runParse = (
  r: HttpResponse.HttpResponse
): Either.Either<readonly (typeof Patient.Schema.Type)[], ParseResult.ParseError> =>
  Effect.runSync(Effect.either(ProfileEntity.parse(r)))

describe('ProfileEntity', () => {
  describe('isFoundAt', () => {
    it.each([
      { url: PROFILE_URL, match: true },
      { url: 'https://tunnel/enduser/profile/v2/me?x=1', match: true },
      // The medication-list neighbour must NOT match (disjointness).
      {
        url: 'https://tunnel/enduser/health/v1/fhir/stu3/pharmacy/Location?subject=x',
        match: false,
      },
      // A different profile sub-path is not the identity endpoint.
      { url: 'https://tunnel/enduser/profile/v2/settings', match: false },
    ])('returns $match for "$url"', ({ url, match }) => {
      expect(ProfileEntity.isFoundAt(url)).toBe(match)
    })
  })

  describe('parse', () => {
    it('synthesizes an R4 Patient from the carebook profile identity', () => {
      const result = runParse(makeResponse(JSON.stringify(profileMe)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      expect(result.right).toHaveLength(1)
      const patient = result.right[0]
      // id is the uid every medication's subject references.
      expect(patient.id).toBe('uid-abc-123')
      expect(patient.birthDate).toBe('1985-07-14')
      expect(patient.name[0]?.family).toBe('Rivera')
      expect(patient.name[0]?.given).toEqual(['Jordan'])
      expect(patient.telecom[0]).toMatchObject({
        system: 'email',
        value: 'jordan.rivera@example.com',
      })
      expect(patient.address[0]?.postalCode).toBe('M5V 2T6')
    })

    it('synthesizes a bare Patient when only the uid is present', () => {
      const result = runParse(
        makeResponse(JSON.stringify({ data: { identifiers: { uid: 'uid-only' } } }))
      )
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      const patient = result.right[0]
      expect(patient.id).toBe('uid-only')
      expect(patient.name).toEqual([])
      expect(patient.birthDate).toBeNull()
      expect(patient.telecom).toEqual([])
    })

    it('reads the name from the nested `names` object, not a flat one', () => {
      // Regression guard: the schema previously read `data.firstName` /
      // `data.lastName`, which the payload does not have. Because the decode is
      // lenient that failed silently, leaving every synthesized Patient nameless.
      const flat = {
        data: { identifiers: { uid: 'uid-1' }, firstName: 'Jordan', lastName: 'Rivera' },
      }
      const result = runParse(makeResponse(JSON.stringify(flat)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      expect(result.right[0]?.name).toEqual([])
    })

    it('ignores blank names rather than synthesizing an empty Patient.name', () => {
      // The carebook profile sends `""` for a name it holds no value for.
      const blank = {
        data: { identifiers: { uid: 'uid-1' }, names: { firstName: '', lastName: '' } },
      }
      const result = runParse(makeResponse(JSON.stringify(blank)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      expect(result.right[0]?.name).toEqual([])
    })

    it('fails with ParseError when the required uid is missing', () => {
      expectLeftToEqual(
        runParse(makeResponse(JSON.stringify({ data: { identifiers: {} } }))),
        expect.objectContaining({ _tag: 'ParseError' })
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
          const result = Effect.runSync(Effect.either(ProfileEntity.parse(makeResponse(json))))
          expect(['Right', 'Left']).toContain(result._tag)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})
