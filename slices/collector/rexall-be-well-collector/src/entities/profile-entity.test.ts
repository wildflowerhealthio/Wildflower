import type { Response } from 'collector-fundamentals/model'
import { makeRemoteResponse } from 'collector-fundamentals/test-helpers'
import { Effect, type Either, type ParseResult } from 'effect'
import * as fc from 'fast-check'
import type { Patient } from 'fhir-r4/resources'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import profileMe from '../fixtures/profile-me.json' with { type: 'json' }
import { RexallSource } from '../source-identity.ts'
import { ProfileEntity } from './profile-entity.ts'

const { expectLeftToEqual } = utilityExpectations(expect)

const PROFILE_URL = 'https://rexall-prd-tunnel.letsbewell.ca/enduser/profile/v2/me'

/** The shape every re-keyed Rexall resource id takes. */
const DERIVED_ID = /^rexall-[0-9a-f]{32}$/

const makeResponse = (body: string, url = PROFILE_URL): Response.RemoteResponse =>
  makeRemoteResponse({ url, body })

const runParse = (
  r: Response.RemoteResponse
): Promise<Either.Either<readonly (typeof Patient.Schema.Type)[], ParseResult.ParseError>> =>
  Effect.runPromise(Effect.either(ProfileEntity.parse(r)))

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
    it('synthesizes an R4 Patient from the carebook profile identity', async () => {
      const result = await runParse(makeResponse(JSON.stringify(profileMe)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      expect(result.right).toHaveLength(1)
      const patient = result.right[0]
      // The stored id is derived from carebook's uid, not carebook's uid itself
      // — the store is shared with every other collector.
      expect(patient.id).toMatch(DERIVED_ID)
      expect(patient.birthDate).toBe('1985-07-14')
      expect(patient.name[0]?.family).toBe('Rivera')
      expect(patient.name[0]?.given).toEqual(['Jordan'])
      expect(patient.telecom[0]).toMatchObject({
        system: 'email',
        value: 'jordan.rivera@example.com',
      })
      expect(patient.address[0]?.postalCode).toBe('M5V 2T6')
    })

    it('records the carebook uid as an identifier', async () => {
      const result = await runParse(makeResponse(JSON.stringify(profileMe)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      // Deriving the id is one-way, so the uid is the only route back to the
      // record on the site.
      expect(result.right[0]?.identifier).toEqual([
        expect.objectContaining({ system: RexallSource.system, value: 'uid-abc-123' }),
      ])
    })

    it('synthesizes a bare Patient when only the uid is present', async () => {
      const result = await runParse(
        makeResponse(JSON.stringify({ data: { identifiers: { uid: 'uid-only' } } }))
      )
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      const patient = result.right[0]
      expect(patient.id).toMatch(DERIVED_ID)
      expect(patient.name).toEqual([])
      expect(patient.birthDate).toBeNull()
      expect(patient.telecom).toEqual([])
    })

    it('reads the name from the nested `names` object, not a flat one', async () => {
      // Regression guard: the schema previously read `data.firstName` /
      // `data.lastName`, which the payload does not have. Because the decode is
      // lenient that failed silently, leaving every synthesized Patient nameless.
      const flat = {
        data: { identifiers: { uid: 'uid-1' }, firstName: 'Jordan', lastName: 'Rivera' },
      }
      const result = await runParse(makeResponse(JSON.stringify(flat)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      expect(result.right[0]?.name).toEqual([])
    })

    it('ignores blank names rather than synthesizing an empty Patient.name', async () => {
      // The carebook profile sends `""` for a name it holds no value for.
      const blank = {
        data: { identifiers: { uid: 'uid-1' }, names: { firstName: '', lastName: '' } },
      }
      const result = await runParse(makeResponse(JSON.stringify(blank)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      expect(result.right[0]?.name).toEqual([])
    })

    it('fails with ParseError when the required uid is missing', async () => {
      expectLeftToEqual(
        await runParse(makeResponse(JSON.stringify({ data: { identifiers: {} } }))),
        expect.objectContaining({ _tag: 'ParseError' })
      )
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
