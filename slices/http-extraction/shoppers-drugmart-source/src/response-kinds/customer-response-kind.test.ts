import { Effect, type Either, Option, type ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { Patient } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { type HttpResponse, Specificity } from 'http-extraction-fundamentals'
import { makeHttpResponse } from 'http-extraction-fundamentals/test-helpers'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { ShoppersIdentifierSystem } from '../shoppers.ts'
import { SHOPPERS_DRUGMART_SYSTEM } from '../source-system.ts'
import { CustomerResponseKind } from './customer-response-kind.ts'

const { expectLeftToEqual } = utilityExpectations(expect)

const CUSTOMERS_BASE = 'https://mypharmacy.shoppersdrugmart.ca'
const ACCOUNT_ID = 'a7353645-83bf-4371-8b87-486b3d5b9802'

const decodePatient = Schema.decodeUnknownSync(Patient.Schema)

const makeResponse = (body: string): HttpResponse.HttpResponse =>
  makeHttpResponse({
    url: `${CUSTOMERS_BASE}/api/v1/customers/pcid/${ACCOUNT_ID}?expand=abc.def`,
    body,
  })

const parse = (payload: unknown): readonly FhirResource[] =>
  Effect.runSync(CustomerResponseKind.parse(makeResponse(JSON.stringify(payload))))

const runParse = (
  r: HttpResponse.HttpResponse
): Either.Either<readonly FhirResource[], ParseResult.ParseError> =>
  Effect.runSync(Effect.either(CustomerResponseKind.parse(r)))

/**
 * A representative multi-patient customers payload modelled on the real capture
 * (two managed people, an account address/telecom), with obviously-fake values.
 * A test can pass its own `customer` (and sibling keys) to pin a minimal shape.
 */
const customerPayload = (overrides?: Record<string, unknown>): Record<string, unknown> =>
  overrides ?? {
    customer: {
      id: 'acct-uuid-1',
      pcid: 'acct-uuid-1',
      firstName: 'Dana',
      lastName: 'Okafor',
      email: 'dana.okafor@example.com',
      phoneNumber: '4165550100',
      address: { line1: '12 Maple Ave', city: 'Toronto', province: 'ON' },
      patients: [
        {
          id: 'pt-uuid-1',
          firstName: 'Dana',
          lastName: 'Okafor',
          displayName: 'Dana Okafor',
          userId: 'acct-uuid-1',
          storeId: 9000,
          phoneNumber: '4165550100',
          address: { line1: '12 Maple Ave', city: 'Toronto', province: 'ON' },
        },
        {
          id: 'pt-uuid-2',
          firstName: 'Sam',
          lastName: 'Okafor',
          displayName: 'Sam Okafor',
          userId: 'acct-uuid-1',
          storeId: 9001,
          phoneNumber: '6135550111',
          address: {
            line1: '77 King St',
            city: 'Ottawa',
            province: 'ON',
            postalCode: 'K1A 0B1',
          },
        },
      ],
    },
    stores: [{ id: 9000 }],
  }

describe('CustomerResponseKind', () => {
  describe('tryRecognize', () => {
    it.each([
      // The exact endpoint: `/api/v1/customers/pcid/<uuid>`.
      { url: `${CUSTOMERS_BASE}/api/v1/customers/pcid/${ACCOUNT_ID}`, match: true },
      // The real request carries an `?expand=…` query.
      { url: `${CUSTOMERS_BASE}/api/v1/customers/pcid/${ACCOUNT_ID}?expand=abc.def`, match: true },
      // A `p1` version segment must NOT match — the pattern pins `v1`.
      { url: `${CUSTOMERS_BASE}/api/p1/customers/pcid/${ACCOUNT_ID}`, match: false },
      // The `pcid` path segment is required — the bare `/customers/<uuid>` form does not match.
      { url: `${CUSTOMERS_BASE}/api/v1/customers/${ACCOUNT_ID}`, match: false },
      // No suffix room: a bare trailing slash or a sub-path must NOT match.
      { url: `${CUSTOMERS_BASE}/api/v1/customers/pcid/${ACCOUNT_ID}/`, match: false },
      {
        url: `${CUSTOMERS_BASE}/api/v1/customers/pcid/${ACCOUNT_ID}/toasts?source=LOGIN`,
        match: false,
      },
      // The exact host is pinned — a foreign host with the same path is rejected.
      { url: `https://tunnel/api/v1/customers/pcid/${ACCOUNT_ID}`, match: false },
      // The neighbouring entities' URLs must NOT match (disjointness).
      {
        url: `${CUSTOMERS_BASE}/api/v1/prescriptions/${ACCOUNT_ID}/prescription-status`,
        match: false,
      },
      {
        url: `${CUSTOMERS_BASE}/api/v1/prescription-history?customerId=${ACCOUNT_ID}`,
        match: false,
      },
    ])('recognizes $match for "$url"', ({ url, match }) => {
      expect(Option.isSome(CustomerResponseKind.tryRecognize(url, Option.none()))).toBe(match)
    })

    it('mints the portal source (system only, no baseUrl) at portal specificity', () => {
      expect(
        CustomerResponseKind.tryRecognize(
          `${CUSTOMERS_BASE}/api/v1/customers/pcid/${ACCOUNT_ID}`,
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
    it('emits a demographic Patient per managed person and a linked account Patient', () => {
      // Act
      const result = parse(customerPayload())

      // Assert — whole-value on the full emitted batch (demographic patients
      // first, in payload order, then the account patient carrying the links).
      expect(result).toStrictEqual([
        decodePatient({
          resourceType: 'Patient',
          id: 'pt-uuid-1',
          identifier: [{ system: ShoppersIdentifierSystem.PatientId, value: 'pt-uuid-1' }],
          name: [{ family: 'Okafor', given: ['Dana'], text: 'Dana Okafor' }],
          telecom: [{ system: 'phone', value: '4165550100' }],
          address: [{ line: ['12 Maple Ave'], city: 'Toronto', state: 'ON' }],
        }),
        decodePatient({
          resourceType: 'Patient',
          id: 'pt-uuid-2',
          identifier: [{ system: ShoppersIdentifierSystem.PatientId, value: 'pt-uuid-2' }],
          name: [{ family: 'Okafor', given: ['Sam'], text: 'Sam Okafor' }],
          telecom: [{ system: 'phone', value: '6135550111' }],
          address: [{ line: ['77 King St'], city: 'Ottawa', state: 'ON', postalCode: 'K1A 0B1' }],
        }),
        decodePatient({
          resourceType: 'Patient',
          id: 'acct-uuid-1',
          identifier: [{ system: ShoppersIdentifierSystem.PcId, value: 'acct-uuid-1' }],
          name: [{ family: 'Okafor', given: ['Dana'] }],
          telecom: [
            { system: 'email', value: 'dana.okafor@example.com' },
            { system: 'phone', value: '4165550100' },
          ],
          address: [{ line: ['12 Maple Ave'], city: 'Toronto', state: 'ON' }],
          link: [
            { other: { reference: 'Patient/pt-uuid-1' }, type: 'seealso' },
            { other: { reference: 'Patient/pt-uuid-2' }, type: 'seealso' },
          ],
        }),
      ])
    })

    it('drops a patient entry with no id and links only the survivors', () => {
      // Arrange — the second patient has no id.
      const payload = customerPayload({
        customer: {
          pcid: 'acct-uuid-1',
          patients: [
            { id: 'pt-uuid-1', firstName: 'Dana', lastName: 'Okafor' },
            { firstName: 'Ghost', lastName: 'NoId' },
          ],
        },
      })

      // Act
      const result = parse(payload)

      // Assert — one demographic Patient, and the account links only to it.
      expect(result).toStrictEqual([
        decodePatient({
          resourceType: 'Patient',
          id: 'pt-uuid-1',
          identifier: [{ system: ShoppersIdentifierSystem.PatientId, value: 'pt-uuid-1' }],
          name: [{ family: 'Okafor', given: ['Dana'] }],
        }),
        decodePatient({
          resourceType: 'Patient',
          id: 'acct-uuid-1',
          identifier: [{ system: ShoppersIdentifierSystem.PcId, value: 'acct-uuid-1' }],
          link: [{ other: { reference: 'Patient/pt-uuid-1' }, type: 'seealso' }],
        }),
      ])
    })

    it('emits a bare account Patient (no link) when there are no managed people', () => {
      // Act
      const result = parse(customerPayload({ customer: { pcid: 'acct-uuid-1' } }))

      // Assert
      expect(result).toStrictEqual([
        decodePatient({
          resourceType: 'Patient',
          id: 'acct-uuid-1',
          identifier: [{ system: ShoppersIdentifierSystem.PcId, value: 'acct-uuid-1' }],
        }),
      ])
    })

    it('fails with ParseError when the required customer.pcid is missing', () => {
      expectLeftToEqual(
        runParse(makeResponse(JSON.stringify({ customer: { firstName: 'Dana' } }))),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    })

    it('never throws on arbitrary JSON strings', () => {
      fc.assert(
        fc.property(fc.json(), (json) => {
          const result = Effect.runSync(
            Effect.either(CustomerResponseKind.parse(makeResponse(json)))
          )
          expect(['Right', 'Left']).toContain(result._tag)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})
