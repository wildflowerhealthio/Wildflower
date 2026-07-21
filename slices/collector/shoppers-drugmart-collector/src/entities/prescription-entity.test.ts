import { DateTime, Effect, type Either, type ParseResult } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { Response } from 'collector-fundamentals/model'
import type { FhirResource } from 'fhir-r4/resources'

import { PrescriptionEntity } from './prescription-entity.ts'

const { expectLeftToEqual } = utilityExpectations(expect)

const encoder = new TextEncoder()

const makeResponse = (body: string): Response.RemoteResponse => {
  const r = new Response.RemoteResponse(
    'https://mypharmacy.shoppersdrugmart.ca/api/v1/prescriptions/rx-uuid-1/prescription-status',
    200,
    'OK',
    [['content-type', 'application/json']]
  )
  r.appendChunk(encoder.encode(body))
  return r
}

const runParse = (
  r: Response.RemoteResponse
): Either.Either<readonly FhirResource[], ParseResult.ParseError> =>
  Effect.runSync(Effect.either(PrescriptionEntity.parse(r)))

/** A representative prescription-status payload; `dispenses` uses the numeric-keyed wrapper. */
const prescriptionJson = (
  overrides: Record<string, unknown> = {},
  dispenses: unknown = [
    {
      '0': {
        dispenseId: 'disp-1',
        quantityDispensed: 30,
        status: 'COMPLETE',
        dispenseDate: '2026-01-10T00:00:00Z',
      },
    },
  ]
): string =>
  JSON.stringify({
    id: 'rx-uuid-1',
    url: '/api/v1/prescriptions/rx-uuid-1',
    storeId: 1414,
    patientId: 'pt-uuid-1',
    prescriptionNumber: 998877,
    brandName: 'Atorvastatin',
    chemicalName: 'atorvastatin 20mg',
    numFillsLeft: 3,
    prescriberName: 'Dr. A Prescriber',
    remainingQuantity: 60,
    status: {
      label: 'Unable to renew online',
      portalLabel: 'Unable to renew online',
      labelDescription: 'Contact your Pharmacy Team for more details',
    },
    din: '02123456',
    direction: 'Take one tablet daily',
    refillQuantity: 90,
    dosageForm: 'tablets',
    expiryDate: '2027-01-01T00:00:00Z',
    lastFillDate: '2026-01-10T00:00:00Z',
    expired: false,
    renewable: false,
    dispenses,
    ...overrides,
  })

/** Filter + narrow a heterogeneous batch to one resource type. */
const byType = <T extends FhirResource['resourceType']>(
  resources: readonly FhirResource[],
  type: T
): ReadonlyArray<Extract<FhirResource, { resourceType: T }>> =>
  resources.filter((r): r is Extract<FhirResource, { resourceType: T }> => r.resourceType === type)

/** Epoch-ms of a decoded FHIR `dateTime` slot (a `DateTime`), format-agnostic. */
const epoch = (dt: DateTime.DateTime | null | undefined): number | undefined =>
  dt == null ? undefined : DateTime.toEpochMillis(dt)

describe('PrescriptionEntity', () => {
  describe('isFoundAt', () => {
    it.each([
      {
        url: 'https://mypharmacy.shoppersdrugmart.ca/api/v1/prescriptions/rx-1/prescription-status',
        match: true,
      },
      // Trailing slash / query still match.
      {
        url: 'https://mypharmacy.shoppersdrugmart.ca/api/v1/prescriptions/rx-1/prescription-status/',
        match: true,
      },
      {
        url: 'https://mypharmacy.shoppersdrugmart.ca/api/v1/prescriptions/rx-1/prescription-status?x=1',
        match: true,
      },
      // Disjoint from the profile pattern and from the bare prescription URL.
      { url: 'https://mypharmacy.shoppersdrugmart.ca/api/profile/getProfile/', match: false },
      {
        url: 'https://mypharmacy.shoppersdrugmart.ca/api/v1/prescriptions/rx-1',
        match: false,
      },
    ])('returns $match for "$url"', ({ url, match }) => {
      expect(PrescriptionEntity.isFoundAt(url)).toBe(match)
    })
  })

  describe('parse', () => {
    it('synthesizes a minimal Patient, a MedicationRequest, and a MedicationDispense', () => {
      const result = Effect.runSync(PrescriptionEntity.parse(makeResponse(prescriptionJson())))
      expect(byType(result, 'Patient')).toHaveLength(1)
      expect(byType(result, 'MedicationRequest')).toHaveLength(1)
      expect(byType(result, 'MedicationDispense')).toHaveLength(1)
    })

    it('keys the minimal Patient by patientId (not pcId) and records it as an identifier', () => {
      const result = Effect.runSync(PrescriptionEntity.parse(makeResponse(prescriptionJson())))
      const [patient] = byType(result, 'Patient')
      expect(patient?.id).toBe('pt-uuid-1')
      expect(patient?.identifier).toEqual([
        expect.objectContaining({
          system: new URL('https://mypharmacy.shoppersdrugmart.ca/fhir/identifier/patient-id'),
          value: 'pt-uuid-1',
        }),
      ])
    })

    it('maps the MedicationRequest fields, keeping status unknown + the portal label in statusReason', () => {
      const result = Effect.runSync(PrescriptionEntity.parse(makeResponse(prescriptionJson())))
      const [request] = byType(result, 'MedicationRequest')
      expect(request?.id).toBe('rx-uuid-1')
      expect(request?.status).toBe('unknown')
      expect(request?.intent).toBe('order')
      expect(request?.subject).toEqual(expect.objectContaining({ reference: 'Patient/pt-uuid-1' }))
      expect(request?.statusReason).toEqual(
        expect.objectContaining({ text: 'Unable to renew online' })
      )
      expect(request?.note).toEqual([
        expect.objectContaining({ text: 'Contact your Pharmacy Team for more details' }),
      ])
      expect(request?.requester).toEqual(expect.objectContaining({ display: 'Dr. A Prescriber' }))
      expect(request?.dosageInstruction).toEqual([
        expect.objectContaining({ text: 'Take one tablet daily' }),
      ])
      expect(request?.identifier).toEqual([
        expect.objectContaining({
          system: new URL(
            'https://mypharmacy.shoppersdrugmart.ca/fhir/identifier/prescription-number'
          ),
          value: '998877',
        }),
      ])
    })

    it('maps medication brand/chemical name and DIN coding onto medicationCodeableConcept', () => {
      const result = Effect.runSync(PrescriptionEntity.parse(makeResponse(prescriptionJson())))
      const [request] = byType(result, 'MedicationRequest')
      // `medicationCodeableConcept` is a `medication[x]` choice-passthrough slot,
      // so it types loosely — index straight into `expect(...)` rather than
      // binding it to a typed const.
      expect(request?.medicationCodeableConcept?.text).toBe('Atorvastatin')
      expect(request?.medicationCodeableConcept?.coding?.[0]?.system).toEqual(
        new URL('https://mypharmacy.shoppersdrugmart.ca/fhir/CodeSystem/din')
      )
      expect(request?.medicationCodeableConcept?.coding?.[0]?.code).toBe('02123456')
      expect(request?.medicationCodeableConcept?.coding?.[0]?.display).toBe('atorvastatin 20mg')
    })

    it('maps numFillsLeft / refillQuantity / expiryDate onto dispenseRequest', () => {
      const result = Effect.runSync(PrescriptionEntity.parse(makeResponse(prescriptionJson())))
      const [request] = byType(result, 'MedicationRequest')
      const dispenseRequest = request?.dispenseRequest
      expect(dispenseRequest?.numberOfRepeatsAllowed).toBe(3)
      expect(dispenseRequest?.quantity?.value).toBe(90)
      expect(dispenseRequest?.validityPeriod?.end).toBeDefined()
    })

    it('opens the validity window at lastFillDate and, absent a nextFillDate, has a null end', () => {
      const result = Effect.runSync(PrescriptionEntity.parse(makeResponse(prescriptionJson())))
      const [request] = byType(result, 'MedicationRequest')
      const period = request?.dispenseRequest?.validityPeriod
      expect(epoch(period?.start)).toBe(Date.parse('2026-01-10T00:00:00Z'))
      expect(epoch(period?.end)).toBe(null)
      // lastFillDate also authors the request.
      expect(epoch(request?.authoredOn)).toBe(Date.parse('2026-01-10T00:00:00Z'))
    })

    it('ends the validity window at nextFillDate in preference to expiryDate', () => {
      const json = prescriptionJson({ nextFillDate: '2026-03-15T00:00:00Z' })
      const result = Effect.runSync(PrescriptionEntity.parse(makeResponse(json)))
      const [request] = byType(result, 'MedicationRequest')
      const period = request?.dispenseRequest?.validityPeriod
      expect(epoch(period?.start)).toBe(Date.parse('2026-01-10T00:00:00Z'))
      expect(epoch(period?.end)).toBe(Date.parse('2026-03-15T00:00:00Z'))
    })

    it('falls back to nextFillDate for authoredOn (and the window end) when lastFillDate is absent', () => {
      const json = prescriptionJson({
        lastFillDate: undefined,
        nextFillDate: '2026-03-15T00:00:00Z',
      })
      const result = Effect.runSync(PrescriptionEntity.parse(makeResponse(json)))
      const [request] = byType(result, 'MedicationRequest')
      expect(epoch(request?.authoredOn)).toBe(Date.parse('2026-03-15T00:00:00Z'))
      const period = request?.dispenseRequest?.validityPeriod
      // No lastFillDate → the window has no start; nextFillDate is its end.
      expect(epoch(period?.start)).toBeUndefined()
      expect(epoch(period?.end)).toBe(Date.parse('2026-03-15T00:00:00Z'))
    })

    it('stamps the storeId onto supportingInformation as a store-locator reference', () => {
      const result = Effect.runSync(PrescriptionEntity.parse(makeResponse(prescriptionJson())))
      const [request] = byType(result, 'MedicationRequest')
      expect(request?.supportingInformation).toEqual([
        expect.objectContaining({
          reference: 'https://www.shoppersdrugmart.ca/store-locator/store/1414',
        }),
      ])
    })

    it('omits supportingInformation when the payload carries no storeId', () => {
      const json = prescriptionJson({ storeId: undefined })
      const result = Effect.runSync(PrescriptionEntity.parse(makeResponse(json)))
      const [request] = byType(result, 'MedicationRequest')
      expect(request?.supportingInformation).toEqual([])
    })

    it('maps a COMPLETE dispense onto a completed MedicationDispense linked to its request', () => {
      const result = Effect.runSync(PrescriptionEntity.parse(makeResponse(prescriptionJson())))
      const [dispense] = byType(result, 'MedicationDispense')
      expect(dispense?.id).toBe('disp-1')
      expect(dispense?.status).toBe('completed')
      expect(dispense?.quantity?.value).toBe(30)
      expect(dispense?.subject).toEqual(expect.objectContaining({ reference: 'Patient/pt-uuid-1' }))
      expect(dispense?.authorizingPrescription).toEqual([
        expect.objectContaining({ reference: 'MedicationRequest/rx-uuid-1' }),
      ])
      expect(dispense?.whenHandedOver).toBeDefined()
    })

    it('accepts a flat (non-wrapped) dispenses array too', () => {
      const json = prescriptionJson({}, [
        {
          dispenseId: 'flat-1',
          quantityDispensed: 15,
          status: 'COMPLETE',
          dispenseDate: '2026-02-01T00:00:00Z',
        },
      ])
      const result = Effect.runSync(PrescriptionEntity.parse(makeResponse(json)))
      const dispenses = byType(result, 'MedicationDispense')
      expect(dispenses).toHaveLength(1)
      expect(dispenses[0]?.id).toBe('flat-1')
    })

    it('drops a dispense with no dispenseId (no logical id to write under)', () => {
      const json = prescriptionJson({}, [{ '0': { quantityDispensed: 5, status: 'COMPLETE' } }])
      const result = Effect.runSync(PrescriptionEntity.parse(makeResponse(json)))
      expect(byType(result, 'MedicationDispense')).toHaveLength(0)
      // The request + patient are still produced.
      expect(byType(result, 'MedicationRequest')).toHaveLength(1)
    })

    it('produces just Patient + MedicationRequest when there are no dispenses', () => {
      const json = prescriptionJson({}, [])
      const result = Effect.runSync(PrescriptionEntity.parse(makeResponse(json)))
      expect(byType(result, 'MedicationDispense')).toHaveLength(0)
      expect(byType(result, 'MedicationRequest')).toHaveLength(1)
      expect(byType(result, 'Patient')).toHaveLength(1)
    })

    it('fails with ParseError when required id / patientId are missing', () => {
      expectLeftToEqual(
        runParse(makeResponse(JSON.stringify({ brandName: 'X' }))),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    })

    it('never throws on arbitrary JSON strings', () => {
      fc.assert(
        fc.property(fc.json(), (json) => {
          const result = Effect.runSync(Effect.either(PrescriptionEntity.parse(makeResponse(json))))
          expect(['Right', 'Left']).toContain(result._tag)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})
