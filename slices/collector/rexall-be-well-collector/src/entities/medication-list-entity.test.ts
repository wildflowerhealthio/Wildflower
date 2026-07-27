import type { Response } from 'collector-fundamentals/model'
import { makeRemoteResponse } from 'collector-fundamentals/test-helpers'
import { Effect, type Either, type ParseResult } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import prescriptions from '../fixtures/prescriptions-searchset.json' with { type: 'json' }
import { MedicationListEntity, type MedicationResource } from './medication-list-entity.ts'

const { expectRightToEqual } = utilityExpectations(expect)

/** The prescriptions searchset URL the SPA fires (tunnel host), matched by `isFoundAt`. */
const LIST_URL =
  'https://rexall-prd-tunnel.letsbewell.ca/enduser/health/v1/fhir/stu3/pharmacy/Location?subject=Patient/uid-abc-123&_query=lastActiveOnly&_revinclude=MedicationRequest:extension.medicationrecord-processor&_count=2147483646'

const makeResponse = (body: string, url = LIST_URL): Response.RemoteResponse =>
  makeRemoteResponse({ url, headers: [['content-type', 'application/fhir+json']], body })

const runParse = (
  r: Response.RemoteResponse
): Either.Either<readonly MedicationResource[], ParseResult.ParseError> =>
  Effect.runSync(Effect.either(MedicationListEntity.parse(r)))

describe('MedicationListEntity', () => {
  describe('isFoundAt', () => {
    it.each([
      // The real prescriptions-page searchset (Location + _revincludes).
      { url: LIST_URL, match: true },
      {
        url: 'https://tunnel/enduser/health/v1/fhir/stu3/pharmacy/Location?subject=x',
        match: true,
      },
      // The profile neighbour must NOT match (disjointness the plan relies on).
      { url: 'https://tunnel/enduser/profile/v2/me', match: false },
      // A single-resource Location URL (no query) is excluded by `mustHaveQuery`.
      { url: 'https://tunnel/enduser/health/v1/fhir/stu3/pharmacy/Location', match: false },
      { url: 'https://tunnel/enduser/health/v1/fhir/stu3/pharmacy/Location/loc-1', match: false },
      // A bare MedicationRequest search is not this pattern.
      {
        url: 'https://tunnel/enduser/health/v1/fhir/stu3/MedicationRequest?patient=x',
        match: false,
      },
    ])('returns $match for "$url"', ({ url, match }) => {
      expect(MedicationListEntity.isFoundAt(url)).toBe(match)
    })
  })

  describe('parse', () => {
    it('keeps only MedicationRequest + MedicationDispense, dropping the other resources', () => {
      const result = runParse(makeResponse(JSON.stringify(prescriptions)))
      // The fixture has 5 entries: Location (match) + MedicationRequest +
      // MedicationDispense + DocumentReference + Immunization. Only the two
      // medications survive; the Location / DocumentReference / Immunization
      // decode to null through the catch-all union member and are dropped.
      expectRightToEqual(result, [
        expect.objectContaining({ resourceType: 'MedicationRequest', id: 'mr-0001' }),
        expect.objectContaining({ resourceType: 'MedicationDispense', id: 'md-0001' }),
      ])
    })

    it('decodes the carebook MedicationRequest straight to its fhir-r4 shape', () => {
      const result = runParse(makeResponse(JSON.stringify(prescriptions)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      const request = result.right.find((r) => r.resourceType === 'MedicationRequest')
      // STU3 requester.agent flattens to the R4 requester reference — proof the
      // R4FromStu3 transform ran (not a raw passthrough).
      if (request?.resourceType !== 'MedicationRequest')
        throw new Error('missing MedicationRequest')
      expect(request.requester?.reference).toBe('Practitioner/dr-smith')
      expect(request.dispenseRequest?.numberOfRepeatsAllowed).toBe(3)
    })

    it('returns an empty array for a searchset with no entries', () => {
      const empty = { resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] }
      expectRightToEqual(runParse(makeResponse(JSON.stringify(empty))), [])
    })

    it('never throws on arbitrary JSON strings', () => {
      fc.assert(
        fc.property(fc.json(), (json) => {
          const result = Effect.runSync(
            Effect.either(MedicationListEntity.parse(makeResponse(json)))
          )
          expect(['Right', 'Left']).toContain(result._tag)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})
