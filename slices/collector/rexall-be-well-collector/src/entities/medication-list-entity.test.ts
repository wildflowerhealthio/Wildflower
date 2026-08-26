import { makeRemoteResponse } from 'collector-fundamentals/test-helpers'
import { Effect, type Either, type ParseResult } from 'effect'
import * as fc from 'fast-check'
import type { HttpResponse } from 'http-extraction-fundamentals'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import prescriptions from '../fixtures/prescriptions-searchset.json' with { type: 'json' }
import { MedicationListEntity, type MedicationResource } from './medication-list-entity.ts'

const { expectRightToEqual } = utilityExpectations(expect)

/** The prescriptions searchset URL the SPA fires (tunnel host), matched by `isFoundAt`. */
const LIST_URL =
  'https://rexall-prd-tunnel.letsbewell.ca/enduser/health/v1/fhir/stu3/pharmacy/Location?subject=Patient/uid-abc-123&_query=lastActiveOnly&_revinclude=MedicationRequest:extension.medicationrecord-processor&_count=2147483646'

const makeResponse = (body: string, url = LIST_URL): HttpResponse.HttpResponse =>
  makeRemoteResponse({ url, headers: [['content-type', 'application/fhir+json']], body })

const runParse = (
  r: HttpResponse.HttpResponse
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
      // The fixture has 7 entries: Location (match) + two MedicationRequests +
      // two MedicationDispenses + DocumentReference + Immunization. Only the
      // four medications survive; the Location / DocumentReference /
      // Immunization decode to null through the catch-all union member and are
      // dropped.
      expectRightToEqual(result, [
        expect.objectContaining({ resourceType: 'MedicationRequest', id: 'mr-0001' }),
        expect.objectContaining({ resourceType: 'MedicationRequest', id: 'mr-0002' }),
        expect.objectContaining({ resourceType: 'MedicationDispense', id: 'md-0001' }),
        expect.objectContaining({ resourceType: 'MedicationDispense', id: 'md-0002' }),
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

    it('promotes the carebook extensions that have a conventional R4 home', () => {
      const result = runParse(makeResponse(JSON.stringify(prescriptions)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      const request = result.right.find((r) => r.id === 'mr-0001')
      if (request?.resourceType !== 'MedicationRequest')
        throw new Error('missing MedicationRequest')

      // Promoted into conventional fields, and gone from `extension`.
      expect(request.doNotPerform).toBe(false)
      expect(request.category[0]?.coding[0]?.code).toBe('refill')
      expect(request.dispenseRequest?.performer?.identifier?.value).toBe('pharmacy-4821')
      expect(request.extension.map((e) => e.url)).not.toContain(
        'http://schemas.carebook.com/v1/fhir/medicationrequest/extension/do-not-perform'
      )

      // The orphaned contained Medication is now reachable.
      expect(request.medicationReference?.reference).toBe('#med-0001')
      expect(request.medicationCodeableConcept).toBeNull()

      // Rexall sends supply durations bare; the day unit is spelled out.
      expect(request.dispenseRequest?.expectedSupplyDuration).toMatchObject({
        value: 30,
        unit: 'day',
        code: 'd',
        system: 'http://unitsofmeasure.org',
      })
    })

    it('leaves the extensions with no conventional home in place', () => {
      const result = runParse(makeResponse(JSON.stringify(prescriptions)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      const request = result.right.find((r) => r.id === 'mr-0001')
      if (request?.resourceType !== 'MedicationRequest')
        throw new Error('missing MedicationRequest')
      const urls = request.extension.map((e) => e.url)
      expect(urls).toContain(
        'http://schemas.carebook.com/v1/fhir/medicationrequest/extension/renewable'
      )
      // Read downstream by medication-sponsorship-react's store-locator link.
      expect(urls).toContain(
        'http://schemas.carebook.com/v1/fhir/medicationrequest/extension/external-store-id'
      )
      expect(urls).toContain(
        'http://schemas.carebook.com/v1/fhir/common/extension/external-system-source'
      )
      // An unrecognized extension is never disturbed.
      expect(urls).toContain('http://example.org/unknown-future-extension')
    })

    it('promotes the dispensing pharmacy onto MedicationDispense.location', () => {
      const result = runParse(makeResponse(JSON.stringify(prescriptions)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      const dispense = result.right.find((r) => r.id === 'md-0001')
      if (dispense?.resourceType !== 'MedicationDispense')
        throw new Error('missing MedicationDispense')
      expect(dispense.location?.identifier?.value).toBe('pharmacy-4821')
      expect(dispense.daysSupply).toMatchObject({ value: 30, unit: 'day', code: 'd' })
      expect(dispense.extension.map((e) => e.url)).not.toContain(
        'http://schemas.carebook.com/v1/fhir/medicationdispense/extension/medication-processor'
      )
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
