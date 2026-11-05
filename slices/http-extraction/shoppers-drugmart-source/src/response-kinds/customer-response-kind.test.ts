import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { type HttpResponse, Specificity } from '@wildflowerhealthio/http-extraction-fundamentals'
import { makeHttpResponse } from '@wildflowerhealthio/http-extraction-fundamentals/test-helpers'
import { numRunsFor, utilityExpectations } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, type Either, Option, type ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { customerUrlOf } from '../portal-url.ts'
import { ShoppersIdentifierSystem } from '../shoppers.ts'
import { CustomerResponseKind } from './customer-response-kind.ts'

const { expectLeftToEqual } = utilityExpectations(expect)

const CUSTOMERS_BASE = 'https://mypharmacy.shoppersdrugmart.ca'
const ACCOUNT_ID = 'a7353645-83bf-4371-8b87-486b3d5b9802'

const decodePatient = Schema.decodeUnknownSync(Patient.Schema)

const makeResponse = (
  body: string,
  url = `${CUSTOMERS_BASE}/api/v1/customers/pcid/${ACCOUNT_ID}?expand=abc.def`
): HttpResponse.HttpResponse => makeHttpResponse({ url, body })

const parse = (payload: unknown, url?: string): readonly DetachedResource.Type[] =>
  Effect.runSync(CustomerResponseKind.parse(makeResponse(JSON.stringify(payload), url)))

/** The `identifier` of each Patient in `resources`. */
const identifiersOf = (resources: readonly DetachedResource.Type[]): readonly unknown[] =>
  resources.map((resource) => (resource.resourceType === 'Patient' ? resource.identifier : null))

/** `system` and `value` as the qualified identifier a decoded Patient carries. */
const identifierIn = (system: string, value: string): IdentifierAndReference.IdentifierType =>
  Schema.decodeUnknownSync(IdentifierAndReference.IdentifierSchema)({ system, value })

/** A customers payload listing just the one person `pt-uuid-1`. */
const onePersonPayload = { customer: { patients: [{ id: 'pt-uuid-1', firstName: 'Dana' }] } }

const runParse = (
  r: HttpResponse.HttpResponse
): Either.Either<readonly DetachedResource.Type[], ParseResult.ParseError> =>
  Effect.runSync(Effect.either(CustomerResponseKind.parse(r)))

/**
 * A representative multi-patient customers payload modelled on the real capture
 * (two managed people, and the account's own fields the kind does not read),
 * with obviously-fake values.
 * A test can pass its own `customer` (and sibling keys) to pin a minimal shape.
 */
const customerPayload = (overrides?: Record<string, unknown>): Record<string, unknown> =>
  overrides ?? {
    customer: {
      id: ACCOUNT_ID,
      pcid: ACCOUNT_ID,
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
          userId: ACCOUNT_ID,
          storeId: 9000,
          phoneNumber: '4165550100',
          address: { line1: '12 Maple Ave', city: 'Toronto', province: 'ON' },
        },
        {
          id: 'pt-uuid-2',
          firstName: 'Sam',
          lastName: 'Okafor',
          displayName: 'Sam Okafor',
          userId: ACCOUNT_ID,
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

    it('claims at portal specificity', () => {
      expect(
        CustomerResponseKind.tryRecognize(
          `${CUSTOMERS_BASE}/api/v1/customers/pcid/${ACCOUNT_ID}`,
          Option.none()
        )
      ).toStrictEqual(Option.some({ specificity: Specificity.PORTAL }))
    })
  })

  describe('parse', () => {
    it('emits a demographic Patient per managed person, in payload order, and none for the account', () => {
      // Act
      const result = parse(customerPayload())

      // Assert — whole-value on the full emitted batch: with two people, the
      // account's own name, email, phone and address become nothing.
      expect(result).toStrictEqual([
        decodePatient({
          resourceType: 'Patient',
          identifier: [{ system: ShoppersIdentifierSystem.PatientId, value: 'pt-uuid-1' }],
          name: [{ family: 'Okafor', given: ['Dana'], text: 'Dana Okafor' }],
          telecom: [{ system: 'phone', value: '4165550100' }],
          address: [{ line: ['12 Maple Ave'], city: 'Toronto', state: 'ON' }],
        }),
        decodePatient({
          resourceType: 'Patient',
          identifier: [{ system: ShoppersIdentifierSystem.PatientId, value: 'pt-uuid-2' }],
          name: [{ family: 'Okafor', given: ['Sam'], text: 'Sam Okafor' }],
          telecom: [{ system: 'phone', value: '6135550111' }],
          address: [{ line: ['77 King St'], city: 'Ottawa', state: 'ON', postalCode: 'K1A 0B1' }],
        }),
      ])
    })

    it.each([
      {
        case: 'the same phone as the person',
        accountPhone: '4165550100',
        telecom: [
          { system: 'phone', value: '4165550100' },
          { system: 'email', value: 'dana.okafor@example.com' },
        ],
      },
      {
        case: 'another phone',
        accountPhone: '4165550199',
        telecom: [
          { system: 'phone', value: '4165550100' },
          { system: 'email', value: 'dana.okafor@example.com' },
          { system: 'phone', value: '4165550199' },
        ],
      },
    ])(
      "gives an account's one person the account's email and phone, once each ($case)",
      ({ accountPhone, telecom }) => {
        const result = parse(
          customerPayload({
            customer: {
              email: 'dana.okafor@example.com',
              phoneNumber: accountPhone,
              patients: [{ id: 'pt-uuid-1', firstName: 'Dana', phoneNumber: '4165550100' }],
            },
          })
        )

        expect(result).toStrictEqual([
          decodePatient({
            resourceType: 'Patient',
            identifier: [
              { system: ShoppersIdentifierSystem.PatientId, value: 'pt-uuid-1' },
              { system: ShoppersIdentifierSystem.CustomerId, value: ACCOUNT_ID },
            ],
            name: [{ given: ['Dana'] }],
            telecom,
          }),
        ])
      }
    )

    it("identifies an account's one person by the account's pcid, under CustomerId, after their key", () => {
      expect(identifiersOf(parse(onePersonPayload))).toStrictEqual([
        [
          identifierIn(ShoppersIdentifierSystem.PatientId, 'pt-uuid-1'),
          identifierIn(ShoppersIdentifierSystem.CustomerId, ACCOUNT_ID),
        ],
      ])
    })

    it("identifies an account's one person by the pcid its URL names, decoded", () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1 }), (pcid) => {
          expect(identifiersOf(parse(onePersonPayload, customerUrlOf(pcid)))).toStrictEqual([
            [
              identifierIn(ShoppersIdentifierSystem.PatientId, 'pt-uuid-1'),
              identifierIn(ShoppersIdentifierSystem.CustomerId, pcid),
            ],
          ])
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    it("identifies an account's one person by their key alone when the URL's pcid does not decode", () => {
      const url = `${CUSTOMERS_BASE}/api/v1/customers/pcid/%E0%A4%A`

      expect(identifiersOf(parse(onePersonPayload, url))).toStrictEqual([
        [identifierIn(ShoppersIdentifierSystem.PatientId, 'pt-uuid-1')],
      ])
    })

    it("identifies each of several people by their key alone, not the account's pcid", () => {
      expect(identifiersOf(parse(customerPayload()))).toStrictEqual([
        [identifierIn(ShoppersIdentifierSystem.PatientId, 'pt-uuid-1')],
        [identifierIn(ShoppersIdentifierSystem.PatientId, 'pt-uuid-2')],
      ])
    })

    it("drops a patient entry with no id, keeps the rest, and gives the survivor none of the account's contacts nor its pcid", () => {
      // Arrange — the second patient has no id, so nothing says the account's
      // email, phone and fills are the first's alone.
      const payload = customerPayload({
        customer: {
          email: 'dana.okafor@example.com',
          phoneNumber: '4165550100',
          patients: [
            { id: 'pt-uuid-1', firstName: 'Dana', lastName: 'Okafor' },
            { firstName: 'Ghost', lastName: 'NoId' },
          ],
        },
      })

      // Act
      const result = parse(payload)

      // Assert — one demographic Patient, without the account's telecom.
      expect(result).toStrictEqual([
        decodePatient({
          resourceType: 'Patient',
          identifier: [{ system: ShoppersIdentifierSystem.PatientId, value: 'pt-uuid-1' }],
          name: [{ family: 'Okafor', given: ['Dana'] }],
        }),
      ])
    })

    it('keeps a patient with an id whose other fields are null or malformed, without those fields', () => {
      // Arrange — the phone number sent as a number, a null last name, an
      // address part that is not a string.
      const payload = customerPayload({
        customer: {
          patients: [
            {
              id: 'pt-uuid-1',
              firstName: 'Dana',
              lastName: null,
              phoneNumber: 4165551234,
              address: { line1: '12 Maple Ave', city: 42, province: 'ON' },
            },
          ],
        },
      })

      // Act
      const result = parse(payload)

      // Assert — the person survives.
      expect(result).toStrictEqual([
        decodePatient({
          resourceType: 'Patient',
          identifier: [
            { system: ShoppersIdentifierSystem.PatientId, value: 'pt-uuid-1' },
            { system: ShoppersIdentifierSystem.CustomerId, value: ACCOUNT_ID },
          ],
          name: [{ given: ['Dana'] }],
          address: [{ line: ['12 Maple Ave'], state: 'ON' }],
        }),
      ])
    })

    it('drops a patient entry that is not an object or whose id is not a string', () => {
      // Arrange
      const payload = customerPayload({
        customer: {
          patients: [null, 'pt-uuid-9', { id: 7, firstName: 'Numeric' }, { id: 'pt-uuid-1' }],
        },
      })

      // Act
      const result = parse(payload)

      // Assert
      expect(
        result.map((resource) =>
          Option.getOrNull(Option.map(DetachedResource.keyOf(resource), ({ value }) => value))
        )
      ).toStrictEqual(['pt-uuid-1'])
    })

    it('emits nothing for a null or absent patients list', () => {
      expect(parse(customerPayload({ customer: { patients: null } }))).toStrictEqual([])
      expect(parse(customerPayload({ customer: { firstName: 'Dana' } }))).toStrictEqual([])
    })

    it('fails with ParseError when the payload has no customer', () => {
      expectLeftToEqual(
        runParse(makeResponse(JSON.stringify({ stores: [] }))),
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
