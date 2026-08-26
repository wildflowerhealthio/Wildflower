import { Effect, type Either, type ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { MedicationDispense, MedicationRequest } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { makeCollectorHttpResponse } from 'collector-fundamentals/test-helpers'
import type { HttpResponse } from 'http-extraction-fundamentals'

import {
  DIN_CODE_SYSTEM,
  PRESCRIPTION_STATUS_TYPE_SYSTEM,
  ShoppersIdentifierSystem,
  shoppersStoreLocatorUrl,
} from '../shoppers.ts'
import { PrescriptionResponseKind } from './prescription-response-kind.ts'

const { expectLeftToEqual } = utilityExpectations(expect)

const STATUS_URL =
  'https://mypharmacy.shoppersdrugmart.ca/api/v1/prescriptions/rx-uuid-1/prescription-status'

const decodeRequest = Schema.decodeUnknownSync(MedicationRequest.Schema)
const decodeDispense = Schema.decodeUnknownSync(MedicationDispense.Schema)

const makeResponse = (body: string): HttpResponse.HttpResponse =>
  makeCollectorHttpResponse({ url: STATUS_URL, body })

const parse = (body: string): readonly FhirResource[] =>
  Effect.runSync(PrescriptionResponseKind.parse(makeResponse(body)))

const runParse = (
  r: HttpResponse.HttpResponse
): Either.Either<readonly FhirResource[], ParseResult.ParseError> =>
  Effect.runSync(Effect.either(PrescriptionResponseKind.parse(r)))

/** Filter + narrow a heterogeneous batch to one resource type. */
const byType = <T extends FhirResource['resourceType']>(
  resources: readonly FhirResource[],
  type: T
): ReadonlyArray<Extract<FhirResource, { resourceType: T }>> =>
  resources.filter((r): r is Extract<FhirResource, { resourceType: T }> => r.resourceType === type)

/**
 * A representative prescription-status payload modelled on the real capture:
 * flat `dispenses`, a machine `status.type`, the top-level status flags, and a
 * `previousPrescription`. Obviously-fake values. `overrides` merges over the
 * base; `dispenses` is passed separately so a test can exercise the wrapper
 * tolerance or the empty case.
 */
const prescriptionJson = (
  overrides: Record<string, unknown> = {},
  dispenses: unknown = [
    {
      dispenseId: 'disp-1',
      quantityDispensed: 30,
      status: 'COMPLETE',
      dispenseDate: '2026-01-10T00:00:00Z',
    },
  ]
): string =>
  JSON.stringify({
    id: 'rx-uuid-1',
    storeId: 1414,
    patientId: 'pt-uuid-1',
    prescriptionNumber: 998877,
    brandName: 'Atorvastatin',
    chemicalName: 'atorvastatin 20mg',
    numFillsLeft: 3,
    prescriberName: 'Dr. A Prescriber',
    status: {
      label: 'Unable to renew online',
      portalLabel: 'Unable to renew online',
      labelDescription: 'Contact your Pharmacy Team for more details',
      type: 'UNABLE_TO_RENEW_ONLINE',
    },
    din: '02123456',
    direction: 'Take one tablet daily',
    refillQuantity: 90,
    expiryDate: '2027-01-01T00:00:00Z',
    lastFillDate: '2026-01-10T00:00:00Z',
    expired: false,
    archived: false,
    renewable: false,
    previousPrescription: 5994285,
    dispenses,
    ...overrides,
  })

/** The MedicationRequest the base fixture is expected to synthesize. */
const expectedRequest = decodeRequest({
  resourceType: 'MedicationRequest',
  id: 'rx-uuid-1',
  status: 'unknown',
  intent: 'order',
  subject: { reference: 'Patient/pt-uuid-1' },
  identifier: [{ system: ShoppersIdentifierSystem.PrescriptionNumber, value: '998877' }],
  medicationCodeableConcept: {
    coding: [{ system: DIN_CODE_SYSTEM, code: '02123456', display: 'atorvastatin 20mg' }],
    text: 'Atorvastatin',
  },
  requester: { display: 'Dr. A Prescriber' },
  statusReason: {
    coding: [{ system: PRESCRIPTION_STATUS_TYPE_SYSTEM, code: 'UNABLE_TO_RENEW_ONLINE' }],
    text: 'Unable to renew online',
  },
  note: [{ text: 'Contact your Pharmacy Team for more details' }],
  priorPrescription: {
    identifier: { system: ShoppersIdentifierSystem.PrescriptionNumber, value: '5994285' },
  },
  authoredOn: '2026-01-10T00:00:00Z',
  dosageInstruction: [{ text: 'Take one tablet daily' }],
  supportingInformation: [{ reference: shoppersStoreLocatorUrl(1414) }],
  dispenseRequest: {
    numberOfRepeatsAllowed: 3,
    quantity: { value: 90 },
    validityPeriod: { start: '2026-01-10T00:00:00Z', end: '2027-01-01T00:00:00Z' },
  },
})

/** The MedicationDispense the base fixture's single dispense is expected to synthesize. */
const expectedDispense = decodeDispense({
  resourceType: 'MedicationDispense',
  id: 'disp-1',
  identifier: [{ system: ShoppersIdentifierSystem.DispenseId, value: 'disp-1' }],
  status: 'completed',
  subject: { reference: 'Patient/pt-uuid-1' },
  authorizingPrescription: [{ reference: 'MedicationRequest/rx-uuid-1' }],
  medicationCodeableConcept: {
    coding: [{ system: DIN_CODE_SYSTEM, code: '02123456', display: 'atorvastatin 20mg' }],
    text: 'Atorvastatin',
  },
  quantity: { value: 30 },
  whenHandedOver: '2026-01-10T00:00:00Z',
})

describe('PrescriptionResponseKind', () => {
  describe('isFoundAt', () => {
    it.each([
      { url: STATUS_URL, match: true },
      // Both API version segments (the capture shows `p1`, docs say `v1`).
      {
        url: 'https://mypharmacy.shoppersdrugmart.ca/api/p1/prescriptions/rx-1/prescription-status',
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
      // Disjoint from the neighbouring entities and from the bare prescription URL.
      {
        url: 'https://mypharmacy.shoppersdrugmart.ca/api/p1/customers/cust-1?expand=abc',
        match: false,
      },
      {
        url: 'https://mypharmacy.shoppersdrugmart.ca/api/p1/prescription-history?customerId=c1',
        match: false,
      },
      { url: 'https://mypharmacy.shoppersdrugmart.ca/api/v1/prescriptions/rx-1', match: false },
    ])('returns $match for "$url"', ({ url, match }) => {
      expect(PrescriptionResponseKind.isFoundAt(url)).toBe(match)
    })
  })

  describe('parse', () => {
    it('synthesizes a MedicationRequest and a MedicationDispense (no Patient)', () => {
      // Act
      const result = parse(prescriptionJson())

      // Assert — whole-value on the full batch; the subject Patient now comes
      // from CustomerResponseKind, so no minimal Patient is emitted here.
      expect(result).toStrictEqual([expectedRequest, expectedDispense])
    })

    it.each([
      { flag: 'expired', expected: 'stopped' },
      { flag: 'archived', expected: 'stopped' },
    ])('maps $flag=true onto MedicationRequest.status $expected', ({ flag, expected }) => {
      // Act
      const [request] = byType(parse(prescriptionJson({ [flag]: true })), 'MedicationRequest')

      // Assert
      expect(request?.status).toBe(expected)
    })

    it('leaves status unknown when neither expired nor archived is set', () => {
      const [request] = byType(parse(prescriptionJson({ renewable: true })), 'MedicationRequest')
      expect(request?.status).toBe('unknown')
    })

    it('accepts the numeric-keyed dispense wrapper too (belt-and-braces)', () => {
      // Arrange — the same single dispense, wrapped in a numeric key.
      const json = prescriptionJson({}, [
        {
          '0': {
            dispenseId: 'disp-1',
            quantityDispensed: 30,
            status: 'COMPLETE',
            dispenseDate: '2026-01-10T00:00:00Z',
          },
        },
      ])

      // Act
      const dispenses = byType(parse(json), 'MedicationDispense')

      // Assert — unwrapped to the identical dispense.
      expect(dispenses).toStrictEqual([expectedDispense])
    })

    it('does not mistake a dispenseId-less dispense for a numeric-keyed wrapper', () => {
      // Arrange — a genuine dispense entry that merely lacks its own
      // `dispenseId` while carrying a nested object that has one. Treating it as
      // a wrapper would harvest that nested value and emit a dispense the feed
      // never listed at top level.
      const json = prescriptionJson({}, [
        { quantityDispensed: 5, detail: { dispenseId: 'not-a-top-level-dispense' } },
      ])

      // Act
      const result = parse(json)

      // Assert — the entry is dropped whole; nothing is harvested out of it.
      expect(byType(result, 'MedicationDispense')).toStrictEqual([])
      expect(byType(result, 'MedicationRequest')).toStrictEqual([expectedRequest])
    })

    it('does not author the request from a future nextFillDate', () => {
      // Arrange — the payload carries only `nextFillDate` (a future date).
      const json = prescriptionJson({
        lastFillDate: undefined,
        nextFillDate: '2030-03-15T00:00:00Z',
      })

      // Act
      const [request] = byType(parse(json), 'MedicationRequest')

      // Assert — `authoredOn` stays unset rather than being future-dated.
      expect(request?.authoredOn).toBeNull()
      // …while the fill window still closes on the next-fill date.
      expect(request?.dispenseRequest?.validityPeriod?.end).not.toBeNull()
    })

    it('omits priorPrescription when the payload carries no previousPrescription', () => {
      const [request] = byType(
        parse(prescriptionJson({ previousPrescription: undefined })),
        'MedicationRequest'
      )
      expect(request?.priorPrescription).toBeNull()
    })

    it('opens the validity window at lastFillDate and ends it at expiryDate absent a nextFillDate', () => {
      const [request] = byType(parse(prescriptionJson()), 'MedicationRequest')
      expect(request?.dispenseRequest?.validityPeriod).toStrictEqual(
        decodeRequest({
          resourceType: 'MedicationRequest',
          status: 'unknown',
          intent: 'order',
          subject: { reference: 'Patient/x' },
          dispenseRequest: {
            validityPeriod: { start: '2026-01-10T00:00:00Z', end: '2027-01-01T00:00:00Z' },
          },
        }).dispenseRequest?.validityPeriod
      )
    })

    it('ends the validity window at nextFillDate in preference to expiryDate', () => {
      const [request] = byType(
        parse(prescriptionJson({ nextFillDate: '2026-03-15T00:00:00Z' })),
        'MedicationRequest'
      )
      const period = request?.dispenseRequest?.validityPeriod
      expect(period?.end).not.toBeNull()
      expect(period).toStrictEqual(
        decodeRequest({
          resourceType: 'MedicationRequest',
          status: 'unknown',
          intent: 'order',
          subject: { reference: 'Patient/x' },
          dispenseRequest: {
            validityPeriod: { start: '2026-01-10T00:00:00Z', end: '2026-03-15T00:00:00Z' },
          },
        }).dispenseRequest?.validityPeriod
      )
    })

    it('drops a dispense with no dispenseId, still emitting the request', () => {
      const json = prescriptionJson({}, [{ quantityDispensed: 5, status: 'COMPLETE' }])
      const result = parse(json)
      expect(byType(result, 'MedicationDispense')).toStrictEqual([])
      expect(byType(result, 'MedicationRequest')).toStrictEqual([expectedRequest])
    })

    it('emits just the MedicationRequest when there are no dispenses', () => {
      const result = parse(prescriptionJson({}, []))
      expect(result).toStrictEqual([expectedRequest])
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
          const result = Effect.runSync(
            Effect.either(PrescriptionResponseKind.parse(makeResponse(json)))
          )
          expect(['Right', 'Left']).toContain(result._tag)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})
