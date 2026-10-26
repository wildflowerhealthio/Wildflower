import {
  CanadianCodingSystem,
  IdentifierAndReference,
} from '@wildflowerhealthio/fhir-r4/data-types'
import { MedicationDispense } from '@wildflowerhealthio/fhir-r4/resources'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { type HttpResponse, Specificity } from '@wildflowerhealthio/http-extraction-fundamentals'
import { makeHttpResponse } from '@wildflowerhealthio/http-extraction-fundamentals/test-helpers'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Logger, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { ShoppersIdentifierSystem, shoppersStoreLocatorUrl } from '../shoppers.ts'
import { SHOPPERS_DRUGMART_SYSTEM } from '../source-system.ts'
import { PrescriptionHistoryResponseKind } from './prescription-history-response-kind.ts'

const BASE = 'https://mypharmacy.shoppersdrugmart.ca'
const ACCOUNT_ID = 'a7353645-83bf-4371-8b87-486b3d5b9802'

const decodeDispense = Schema.decodeUnknownSync(MedicationDispense.Schema)
const decodeReference = Schema.decodeUnknownSync(IdentifierAndReference.ReferenceSchema)

const HISTORY_URL = `${BASE}/api/v1/prescription-history?customerId=${ACCOUNT_ID}`

const makeResponse = (body: string, url: string = HISTORY_URL): HttpResponse.HttpResponse =>
  makeHttpResponse({ url, body })

/** The identifier-only reference to the account `customerId` names, as a history dispense's subject. */
const accountSubject = (customerId: string = ACCOUNT_ID): Record<string, unknown> => ({
  identifier: { system: ShoppersIdentifierSystem.CustomerId, value: customerId },
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
      // A `p1` version segment must NOT match — the pattern pins `v1`.
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
      expect(Option.isSome(PrescriptionHistoryResponseKind.tryRecognize(url, Option.none()))).toBe(
        match
      )
    })

    it('mints the portal source (system only, no baseUrl) at portal specificity', () => {
      expect(
        PrescriptionHistoryResponseKind.tryRecognize(
          `${BASE}/api/v1/prescription-history?customerId=${ACCOUNT_ID}`,
          Option.none()
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
          subject: accountSubject(),
          medicationCodeableConcept: {
            coding: [
              { system: CanadianCodingSystem.Din, code: '51480840', display: 'Amoxicillin 500mg' },
            ],
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
          subject: accountSubject(),
          medicationCodeableConcept: {
            coding: [
              { system: CanadianCodingSystem.Din, code: '80717730', display: 'Amoxicillin 500mg' },
            ],
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

    it('should name the store after its number when the portal gives no store name', () => {
      // Arrange
      const payload = {
        dispenses: [{ prescriptionId: 'rx-uuid-1', dispenseId: 'disp-1', store: { id: 9000 } }],
      }

      // Act
      const [dispense] = parse(payload)

      // Assert
      if (dispense?.resourceType !== 'MedicationDispense') throw new Error('expected a dispense')
      expect(dispense.location?.display).toBe('Shoppers Drug Mart (store 9000)')
    })

    it.each([
      { customerId: ACCOUNT_ID, query: `customerId=${ACCOUNT_ID}` },
      // customerId need not be the first query parameter.
      { customerId: 'other-account', query: 'lang=en&customerId=other-account' },
    ])(
      "names the account by the URL's customerId alone, with no literal reference ($query)",
      ({ customerId, query }) => {
        // Arrange
        const url = `${BASE}/api/v1/prescription-history?${query}`

        // Act
        const result = Effect.runSync(
          PrescriptionHistoryResponseKind.parse(makeResponse(JSON.stringify(historyPayload()), url))
        )

        // Assert
        const subject = decodeReference(accountSubject(customerId))
        expect(subject.reference).toBeNull()
        expect(
          result.map((resource) =>
            resource.resourceType === 'MedicationDispense' ? resource.subject : null
          )
        ).toStrictEqual([subject, subject])
      }
    )

    it('fails with ParseError when the URL names no customerId', () => {
      const url = `${BASE}/api/v1/prescription-history?customerId=`

      const result = Effect.runSync(
        Effect.either(
          PrescriptionHistoryResponseKind.parse(makeResponse(JSON.stringify(historyPayload()), url))
        )
      )

      expect(result).toMatchObject({ _tag: 'Left', left: { _tag: 'ParseError' } })
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
          subject: accountSubject(),
          medicationCodeableConcept: {
            coding: [{ system: CanadianCodingSystem.Din, code: '51480840' }],
          },
          authorizingPrescription: [{ reference: 'MedicationRequest/rx-uuid-1' }],
        }),
      ])
    })

    it('drops and counts an undecodable dispense, still emitting its siblings', () => {
      // Arrange — beside a good fill: one whose quantity the portal sent as a
      // string, a null entry, an entry that is not an object, and one with no
      // dispenseId.
      const payload = {
        dispenses: [
          { prescriptionId: 'rx-uuid-1', dispenseId: 'disp-8', quantityDispensed: '30' },
          null,
          'disp-10',
          { prescriptionId: 'rx-uuid-1', dispenseId: null, quantityDispensed: 5 },
          { prescriptionId: 'rx-uuid-1', dispenseId: 'disp-9', din: '51480840' },
        ],
      }
      const logged: unknown[] = []
      const capturingLogger = Logger.make(({ message }) => {
        logged.push(message)
      })

      // Act
      const result = Effect.runSync(
        PrescriptionHistoryResponseKind.parse(makeResponse(JSON.stringify(payload))).pipe(
          Effect.provide(Logger.replace(Logger.defaultLogger, capturingLogger))
        )
      )

      // Assert — only the decodable entry with a dispenseId survives, and the
      // four others are counted.
      expect(result.map((resource) => resource.id)).toStrictEqual(['disp-9'])
      expect(logged).toStrictEqual([
        [
          'PrescriptionHistoryResponseKind: dropped 4 of 5 dispense entries (3 undecodable, 1 with no dispenseId)',
        ],
      ])
    })

    it('property: an optional field sent as null reads as absent', () => {
      const dispenseKeys = [
        'prescriptionId',
        'prescriptionNumber',
        'dispenseDate',
        'chemicalName',
        'brandName',
        'quantityDispensed',
        'din',
        'store',
      ] as const
      const storeKeys = ['id', 'storeName'] as const
      const first = {
        prescriptionId: 'rx-uuid-1',
        dispenseId: 'disp-1',
        prescriptionNumber: 9534360,
        dispenseDate: '2033-05-13',
        chemicalName: 'Amoxicillin 500mg',
        brandName: 'Amoxil',
        quantityDispensed: 30,
        din: '51480840',
        store: { id: 9000, storeName: 'SDM Pharmacy #9000' },
      }
      const second = { prescriptionId: 'rx-uuid-1', dispenseId: 'disp-2' }
      /** `keys` all set to `value` (`undefined` keys are left out of the JSON). */
      const allSetTo = (
        keys: readonly string[],
        value: null | undefined
      ): Record<string, null | undefined> => Object.fromEntries(keys.map((key) => [key, value]))

      fc.assert(
        fc.property(
          fc.subarray([...dispenseKeys]),
          fc.subarray([...storeKeys]),
          (nulledKeys, nulledStoreKeys) => {
            const payloadWith = (value: null | undefined): unknown => ({
              dispenses: [
                { ...first, ...allSetTo(nulledKeys, value) },
                {
                  ...second,
                  store: { id: 9000, storeName: 'SDM', ...allSetTo(nulledStoreKeys, value) },
                },
              ],
            })
            expect(parse(payloadWith(null))).toStrictEqual(parse(payloadWith(undefined)))
          }
        ),
        { numRuns: numRunsFor({ base: 50 }) }
      )
    })

    it('emits nothing for a null dispenses list', () => {
      expect(parse({ dispenses: null })).toStrictEqual([])
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
