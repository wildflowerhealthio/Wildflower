import { Effect, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { MedicationDispense } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { type HttpResponse, Specificity } from 'http-extraction-fundamentals'
import { makeHttpResponse } from 'http-extraction-fundamentals/test-helpers'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { DIN_CODE_SYSTEM, ShoppersIdentifierSystem, shoppersStoreLocatorUrl } from '../shoppers.ts'
import { SHOPPERS_DRUGMART_SYSTEM } from '../source-system.ts'
import { PrescriptionHistoryResponseKind } from './prescription-history-response-kind.ts'

const BASE = 'https://mypharmacy.shoppersdrugmart.ca'
const ACCOUNT_ID = 'a7353645-83bf-4371-8b87-486b3d5b9802'

const decodeDispense = Schema.decodeUnknownSync(MedicationDispense.Schema)

const makeResponse = (body: string): HttpResponse.HttpResponse =>
  makeHttpResponse({
    url: `${BASE}/api/v1/prescription-history?customerId=${ACCOUNT_ID}`,
    body,
  })

const parse = (payload: unknown): readonly FhirResource[] =>
  Effect.runSync(PrescriptionHistoryResponseKind.parse(makeResponse(JSON.stringify(payload))))

/**
 * A representative history payload modelled on the real capture: two fills of
 * **one** prescription (`rx-uuid-1`) carrying **different** DINs (a brand ↔
 * generic swap between dispenses), plus a fully-described dispensing store on the
 * first. Obviously-fake values.
 */
const historyPayload = (): Record<string, unknown> => ({
  dispenses: [
    {
      prescriptionId: 'rx-uuid-1',
      dispenseId: 'disp-1',
      prescriptionNumber: 9534360,
      dispenseDate: '2033-05-13',
      chemicalName: 'Amoxicillin 500mg',
      brandName: 'Amoxil',
      quantityDispensed: 30,
      prescriberName: 'Dr. A Prescriber',
      din: '51480840',
      isArchive: false,
      store: {
        id: 9000,
        storeName: 'SDM Pharmacy #9000',
        phoneNumber: '4165550000',
        storeType: 'Pharmacy',
        address: { line1: '1 Main St', city: 'Toronto', province: 'ON', postalCode: 'M5V 2T6' },
      },
    },
    {
      prescriptionId: 'rx-uuid-1',
      dispenseId: 'disp-2',
      prescriptionNumber: 9534360,
      dispenseDate: '2033-08-01',
      chemicalName: 'Amoxicillin 500mg',
      brandName: 'Apo-Amoxi',
      quantityDispensed: 30,
      din: '80717730',
      isArchive: false,
      store: { id: 9000, storeName: 'SDM Pharmacy #9000' },
    },
  ],
})

describe('PrescriptionHistoryResponseKind', () => {
  describe('tryRecognize', () => {
    it.each([
      { url: `${BASE}/api/v1/prescription-history?customerId=${ACCOUNT_ID}`, match: true },
      // `customerId` need not be the first query parameter.
      { url: `${BASE}/api/v1/prescription-history?lang=en&customerId=${ACCOUNT_ID}`, match: true },
      // The API version is now pinned to `v1` — the old `p1` capture no longer matches.
      { url: `${BASE}/api/p1/prescription-history?customerId=${ACCOUNT_ID}`, match: false },
      // The user-facing page (no `customerId` query) must NOT match.
      { url: `${BASE}/en/prescription-history`, match: false },
      { url: `${BASE}/api/v1/prescription-history`, match: false },
      // The exact host is pinned — a foreign host with the same path is rejected.
      { url: `https://tunnel/api/v1/prescription-history?customerId=${ACCOUNT_ID}`, match: false },
      // The neighbouring entities' URLs must NOT match (disjointness).
      { url: `${BASE}/api/v1/customers/pcid/${ACCOUNT_ID}?expand=abc`, match: false },
      { url: `${BASE}/api/v1/prescriptions/rx-1/prescription-status`, match: false },
    ])('recognizes $match for "$url"', ({ url, match }) => {
      expect(Option.isSome(PrescriptionHistoryResponseKind.tryRecognize(url))).toBe(match)
    })

    it('mints the portal source (system only, no baseUrl) at portal specificity', () => {
      expect(
        PrescriptionHistoryResponseKind.tryRecognize(
          `${BASE}/api/v1/prescription-history?customerId=${ACCOUNT_ID}`
        )
      ).toStrictEqual(
        Option.some({
          specificity: Specificity.PORTAL,
          source: { system: SHOPPERS_DRUGMART_SYSTEM },
        })
      )
    })
  })

  describe('parse', () => {
    it('emits one MedicationDispense per entry, each carrying its own DIN and store', () => {
      // Act
      const result = parse(historyPayload())

      // Assert — whole-value on both dispenses. Same prescription, different DINs.
      expect(result).toStrictEqual([
        decodeDispense({
          resourceType: 'MedicationDispense',
          id: 'disp-1',
          identifier: [{ system: ShoppersIdentifierSystem.DispenseId, value: 'disp-1' }],
          status: 'completed',
          medicationCodeableConcept: {
            coding: [{ system: DIN_CODE_SYSTEM, code: '51480840', display: 'Amoxicillin 500mg' }],
            text: 'Amoxil',
          },
          authorizingPrescription: [
            {
              reference: 'MedicationRequest/rx-uuid-1',
              identifier: { system: ShoppersIdentifierSystem.PrescriptionNumber, value: '9534360' },
            },
          ],
          quantity: { value: 30 },
          whenHandedOver: '2033-05-13',
          location: { reference: shoppersStoreLocatorUrl(9000), display: 'SDM Pharmacy #9000' },
        }),
        decodeDispense({
          resourceType: 'MedicationDispense',
          id: 'disp-2',
          identifier: [{ system: ShoppersIdentifierSystem.DispenseId, value: 'disp-2' }],
          status: 'completed',
          medicationCodeableConcept: {
            coding: [{ system: DIN_CODE_SYSTEM, code: '80717730', display: 'Amoxicillin 500mg' }],
            text: 'Apo-Amoxi',
          },
          authorizingPrescription: [
            {
              reference: 'MedicationRequest/rx-uuid-1',
              identifier: { system: ShoppersIdentifierSystem.PrescriptionNumber, value: '9534360' },
            },
          ],
          quantity: { value: 30 },
          whenHandedOver: '2033-08-01',
          location: { reference: shoppersStoreLocatorUrl(9000), display: 'SDM Pharmacy #9000' },
        }),
      ])
    })

    it('emits no subject (the history payload carries no patientId)', () => {
      // Act
      const [dispense] = parse(historyPayload())

      // Assert
      if (dispense?.resourceType !== 'MedicationDispense') throw new Error('expected a dispense')
      expect(dispense.subject).toBeNull()
    })

    it('drops a dispense with no dispenseId and keeps the rest', () => {
      // Arrange — one entry has no dispenseId.
      const payload = {
        dispenses: [
          { prescriptionId: 'rx-uuid-1', quantityDispensed: 5 },
          { prescriptionId: 'rx-uuid-1', dispenseId: 'disp-9', din: '51480840' },
        ],
      }

      // Act
      const result = parse(payload)

      // Assert — only the entry with a dispenseId survives.
      expect(result).toStrictEqual([
        decodeDispense({
          resourceType: 'MedicationDispense',
          id: 'disp-9',
          identifier: [{ system: ShoppersIdentifierSystem.DispenseId, value: 'disp-9' }],
          status: 'completed',
          medicationCodeableConcept: {
            coding: [{ system: DIN_CODE_SYSTEM, code: '51480840' }],
          },
          authorizingPrescription: [{ reference: 'MedicationRequest/rx-uuid-1' }],
        }),
      ])
    })

    it('emits nothing for an empty dispenses array', () => {
      expect(parse({ dispenses: [] })).toStrictEqual([])
    })

    it('never throws on arbitrary JSON strings', () => {
      fc.assert(
        fc.property(fc.json(), (json) => {
          const result = Effect.runSync(
            Effect.either(PrescriptionHistoryResponseKind.parse(makeResponse(json)))
          )
          expect(['Right', 'Left']).toContain(result._tag)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})
