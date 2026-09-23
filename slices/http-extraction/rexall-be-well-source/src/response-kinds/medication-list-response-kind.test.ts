import { Effect, type Either, Option, type ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { CanadianCodingSystem, CodeableConcept, WildflowerExtension } from 'fhir-r4/data-types'
import { type HttpResponse, Specificity } from 'http-extraction-fundamentals'
import { makeHttpResponse } from 'http-extraction-fundamentals/test-helpers'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { CarebookCodingSystem, CarebookExtension } from '../carebook.ts'
import prescriptions from '../fixtures/prescriptions-searchset.json' with { type: 'json' }
import { REXALL_CAREBOOK_SYSTEM } from '../source-system.ts'
import {
  MedicationListResponseKind,
  type MedicationResource,
} from './medication-list-response-kind.ts'

const { expectRightToEqual } = utilityExpectations(expect)

/** `medication[x]` is loosely typed on the decoded resource; read it as a concept. */
const decodeConcept = Schema.decodeUnknownSync(Schema.typeSchema(CodeableConcept.Schema))

/** The prescriptions searchset URL the SPA fires (tunnel host), matched by `tryRecognize`. */
const LIST_URL =
  'https://rexall-prd-tunnel.letsbewell.ca/enduser/health/v1/fhir/stu3/pharmacy/Location?subject=Patient/uid-abc-123&_query=lastActiveOnly&_revinclude=MedicationRequest:extension.medicationrecord-processor&_count=2147483646'

const makeResponse = (body: string, url = LIST_URL): HttpResponse.HttpResponse =>
  makeHttpResponse({ url, headers: [['content-type', 'application/fhir+json']], body })

const runParse = (
  r: HttpResponse.HttpResponse
): Either.Either<readonly MedicationResource[], ParseResult.ParseError> =>
  Effect.runSync(Effect.either(MedicationListResponseKind.parse(r)))

describe('MedicationListResponseKind', () => {
  describe('tryRecognize', () => {
    const LIST_BASE = 'https://rexall-prd-tunnel.letsbewell.ca/enduser/health/v1/fhir/stu3'
    it.each([
      // The real prescriptions-page searchset (Location + _revincludes).
      { url: LIST_URL, match: true },
      { url: `${LIST_BASE}/pharmacy/Location?subject=x`, match: true },
      // The exact host is pinned — a foreign host with the same path is rejected.
      {
        url: 'https://tunnel/enduser/health/v1/fhir/stu3/pharmacy/Location?subject=x',
        match: false,
      },
      // No prefix room: a base-path-prefixed variant on the real host is rejected.
      {
        url: 'https://rexall-prd-tunnel.letsbewell.ca/proxy/enduser/health/v1/fhir/stu3/pharmacy/Location?subject=x',
        match: false,
      },
      // The profile neighbour must NOT match (disjointness the plan relies on).
      { url: 'https://rexall-prd-tunnel.letsbewell.ca/enduser/profile/v2/me', match: false },
      // A single-resource Location URL (no query) is excluded — the pattern requires a query.
      { url: `${LIST_BASE}/pharmacy/Location`, match: false },
      { url: `${LIST_BASE}/pharmacy/Location/loc-1`, match: false },
      // A bare MedicationRequest search is not this pattern.
      { url: `${LIST_BASE}/MedicationRequest?patient=x`, match: false },
    ])('recognizes $match for "$url"', ({ url, match }) => {
      expect(Option.isSome(MedicationListResponseKind.tryRecognize(url, Option.none()))).toBe(match)
    })

    it('mints the portal source (system only, no baseUrl) at portal specificity', () => {
      expect(MedicationListResponseKind.tryRecognize(LIST_URL, Option.none())).toStrictEqual(
        Option.some({
          specificity: Specificity.PORTAL,
          source: { system: REXALL_CAREBOOK_SYSTEM },
        })
      )
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
      // An unrecognized extension is never disturbed.
      expect(urls).toContain('http://example.org/unknown-future-extension')
    })

    it('lifts the DIN, store link and remaining repeats into conventional slots', () => {
      const result = runParse(makeResponse(JSON.stringify(prescriptions)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      const request = result.right.find((r) => r.id === 'mr-0001')
      if (request?.resourceType !== 'MedicationRequest')
        throw new Error('missing MedicationRequest')

      // The store link lands on the performer beside carebook's own pharmacy id,
      // and both extensions that spelled it are consumed.
      expect(request.dispenseRequest?.performer?.reference).toBe(
        'https://www.rexall.ca/storelocator/store/4821'
      )
      expect(request.dispenseRequest?.performer?.identifier?.value).toBe('pharmacy-4821')
      const urls = request.extension.map((e) => e.url)
      expect(urls).not.toContain(CarebookExtension.RequestExternalStoreId)
      expect(urls).not.toContain(CarebookExtension.ExternalSystemSource)

      // Both remaining-repeats copies collapse into one Wildflower extension.
      expect(request.dispenseRequest?.modifierExtension).toEqual([])
      expect(request.dispenseRequest?.extension.map((e) => [e.url, e.valueInteger])).toStrictEqual([
        [WildflowerExtension.RepeatsAvailable, 2],
      ])

      // The contained Medication's DIN gains its canonical twin, vendor kept.
      const medication: unknown = request.contained[0]
      expect(medication).toMatchObject({
        code: {
          coding: [
            { system: CarebookCodingSystem.Din, code: '02241497' },
            { system: CanadianCodingSystem.Din, code: '02241497' },
          ],
        },
      })
    })

    it('holds the store link on a fresh performer when no medication-processor named one', () => {
      const result = runParse(makeResponse(JSON.stringify(prescriptions)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      const request = result.right.find((r) => r.id === 'mr-0002')
      if (request?.resourceType !== 'MedicationRequest')
        throw new Error('missing MedicationRequest')
      expect(request.dispenseRequest?.performer?.reference).toBe(
        'https://www.rexall.ca/storelocator/store/4821'
      )
      expect(request.dispenseRequest?.performer?.identifier).toBeNull()
    })

    it('promotes the dispensing pharmacy onto MedicationDispense.location', () => {
      const result = runParse(makeResponse(JSON.stringify(prescriptions)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      const dispense = result.right.find((r) => r.id === 'md-0001')
      if (dispense?.resourceType !== 'MedicationDispense')
        throw new Error('missing MedicationDispense')
      expect(dispense.location?.identifier?.value).toBe('pharmacy-4821')
      // The store link mirrors the request's performer.
      expect(dispense.location?.reference).toBe('https://www.rexall.ca/storelocator/store/4821')
      const concept = decodeConcept(dispense.medicationCodeableConcept)
      expect(concept.coding.map((c) => [c.system?.href, c.code])).toStrictEqual([
        [CarebookCodingSystem.Din, '02241497'],
        [CanadianCodingSystem.Din, '02241497'],
      ])
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
            Effect.either(MedicationListResponseKind.parse(makeResponse(json)))
          )
          expect(['Right', 'Left']).toContain(result._tag)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})
