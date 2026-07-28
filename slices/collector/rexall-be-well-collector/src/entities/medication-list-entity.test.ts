import type { Response } from 'collector-fundamentals/model'
import { makeRemoteResponse } from 'collector-fundamentals/test-helpers'
import { Effect, type Either, type ParseResult } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import prescriptions from '../fixtures/prescriptions-searchset.json' with { type: 'json' }
import profileMe from '../fixtures/profile-me.json' with { type: 'json' }
import { RexallSource } from '../source-identity.ts'
import { MedicationListEntity, type MedicationResource } from './medication-list-entity.ts'
import { ProfileEntity } from './profile-entity.ts'

const { expectRightToEqual } = utilityExpectations(expect)

/** The prescriptions searchset URL the SPA fires (tunnel host), matched by `isFoundAt`. */
const LIST_URL =
  'https://rexall-prd-tunnel.letsbewell.ca/enduser/health/v1/fhir/stu3/pharmacy/Location?subject=Patient/uid-abc-123&_query=lastActiveOnly&_revinclude=MedicationRequest:extension.medicationrecord-processor&_count=2147483646'

/** The profile endpoint, so one test can drive both entities of a run. */
const PROFILE_URL = 'https://rexall-prd-tunnel.letsbewell.ca/enduser/profile/v2/me'

/** The shape every re-keyed Rexall resource id takes. */
const DERIVED_ID = /^rexall-[0-9a-f]{32}$/

/** The resources of a parse that was expected to succeed. */
const parsedResources = async (
  r: Response.RemoteResponse
): Promise<readonly MedicationResource[]> => {
  const result = await runParse(r)
  if (result._tag !== 'Right') throw new Error('expected a successful parse')
  return result.right
}

/**
 * The medication carebook sent under `sourceId`. The stored `id` is derived, so
 * the carebook id it was re-keyed from is only reachable as an `Identifier` —
 * which is what makes the promotion expectations below still name a fixture
 * entry rather than a hash.
 */
const bySourceId = (
  resources: readonly MedicationResource[],
  sourceId: string
): MedicationResource | undefined =>
  resources.find((resource) =>
    resource.identifier.some(
      (identifier) =>
        identifier.system?.href === RexallSource.system.href && identifier.value === sourceId
    )
  )

const makeResponse = (body: string, url = LIST_URL): Response.RemoteResponse =>
  makeRemoteResponse({ url, headers: [['content-type', 'application/fhir+json']], body })

const runParse = (
  r: Response.RemoteResponse
): Promise<Either.Either<readonly MedicationResource[], ParseResult.ParseError>> =>
  Effect.runPromise(Effect.either(MedicationListEntity.parse(r)))

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
    it('keeps only MedicationRequest + MedicationDispense, dropping the other resources', async () => {
      // Act — the fixture has 7 entries: Location (match) + two
      // MedicationRequests + two MedicationDispenses + DocumentReference +
      // Immunization. Only the four medications survive; the Location /
      // DocumentReference / Immunization decode to null through the catch-all
      // union member and are dropped.
      const medications = await parsedResources(makeResponse(JSON.stringify(prescriptions)))

      // Assert
      expect(medications.map((resource) => resource.resourceType)).toEqual([
        'MedicationRequest',
        'MedicationRequest',
        'MedicationDispense',
        'MedicationDispense',
      ])
      for (const resource of medications) expect(resource.id).toMatch(DERIVED_ID)
    })

    it('records the carebook ids the medications arrived with', async () => {
      // Act
      const medications = await parsedResources(makeResponse(JSON.stringify(prescriptions)))

      // Assert — the ids are derived, so carebook's own are kept as identifiers,
      // beside the carebook external-id identifier the dialect already carries.
      expect(medications.map((resource) => resource.identifier)).toEqual([
        expect.arrayContaining([
          expect.objectContaining({ system: RexallSource.system, value: 'mr-0001' }),
        ]),
        expect.arrayContaining([
          expect.objectContaining({ system: RexallSource.system, value: 'mr-0002' }),
        ]),
        expect.arrayContaining([
          expect.objectContaining({ system: RexallSource.system, value: 'md-0001' }),
        ]),
        expect.arrayContaining([
          expect.objectContaining({ system: RexallSource.system, value: 'md-0002' }),
        ]),
      ])
    })

    it('links every medication to the Patient the profile synthesizes', async () => {
      // The invariant re-keying exists to preserve: two entities, two
      // responses, one namespace — so `subject` still names the stored Patient.
      const medications = await parsedResources(makeResponse(JSON.stringify(prescriptions)))
      const profile = await Effect.runPromise(
        ProfileEntity.parse(
          makeRemoteResponse({ url: PROFILE_URL, body: JSON.stringify(profileMe) })
        )
      )

      // Assert — all four, so a medication left behind by the rewrite shows up
      // as a missing entry rather than a shorter list that still matches.
      expect(medications.map((resource) => resource.subject?.reference)).toEqual(
        Array.from({ length: 4 }, () => `Patient/${profile[0]?.id}`)
      )
    })

    it('decodes the carebook MedicationRequest straight to its fhir-r4 shape', async () => {
      const medications = await parsedResources(makeResponse(JSON.stringify(prescriptions)))
      const request = medications.find((r) => r.resourceType === 'MedicationRequest')
      // STU3 requester.agent flattens to the R4 requester reference — proof the
      // R4FromStu3 transform ran (not a raw passthrough).
      if (request?.resourceType !== 'MedicationRequest')
        throw new Error('missing MedicationRequest')
      // Re-keyed like every other relative reference, and traceable back to
      // the id carebook stated.
      expect(request.requester?.reference).toMatch(/^Practitioner\/rexall-[0-9a-f]{32}$/)
      expect(request.requester?.identifier).toEqual(
        expect.objectContaining({ system: RexallSource.system, value: 'dr-smith' })
      )
      expect(request.dispenseRequest?.numberOfRepeatsAllowed).toBe(3)
    })

    it('promotes the carebook extensions that have a conventional R4 home', async () => {
      const medications = await parsedResources(makeResponse(JSON.stringify(prescriptions)))
      const request = bySourceId(medications, 'mr-0001')
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

    it('leaves the extensions with no conventional home in place', async () => {
      const medications = await parsedResources(makeResponse(JSON.stringify(prescriptions)))
      const request = bySourceId(medications, 'mr-0001')
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

    it('promotes the dispensing pharmacy onto MedicationDispense.location', async () => {
      const medications = await parsedResources(makeResponse(JSON.stringify(prescriptions)))
      const dispense = bySourceId(medications, 'md-0001')
      if (dispense?.resourceType !== 'MedicationDispense')
        throw new Error('missing MedicationDispense')
      expect(dispense.location?.identifier?.value).toBe('pharmacy-4821')
      expect(dispense.daysSupply).toMatchObject({ value: 30, unit: 'day', code: 'd' })
      expect(dispense.extension.map((e) => e.url)).not.toContain(
        'http://schemas.carebook.com/v1/fhir/medicationdispense/extension/medication-processor'
      )
    })

    it('returns an empty array for a searchset with no entries', async () => {
      const empty = { resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] }
      expectRightToEqual(await runParse(makeResponse(JSON.stringify(empty))), [])
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
