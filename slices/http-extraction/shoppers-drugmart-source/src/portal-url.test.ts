import type { HttpMethod } from '@wildflowerhealthio/http-extraction-fundamentals'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  customerUrlOf,
  prescriptionHistoryUrlOf,
  prescriptionStatusUrlOf,
  SHOPPERS_API_BASE_URL,
  tryDecodeUriComponent,
  tryPcidFromUrlParam,
} from './portal-url.ts'
import { CustomerResponseKind } from './response-kinds/customer-response-kind.ts'
import { PrescriptionHistoryResponseKind } from './response-kinds/prescription-history-response-kind.ts'
import { PrescriptionResponseKind } from './response-kinds/prescription-response-kind.ts'

const KINDS = {
  customer: CustomerResponseKind,
  prescription: PrescriptionResponseKind,
  history: PrescriptionHistoryResponseKind,
} as const

/** The kinds that recognize a request for `url` with `method`, by name. */
const recognizersOf = (url: string, method: Option.Option<HttpMethod>): readonly string[] =>
  Object.entries(KINDS).flatMap(([name, kind]) =>
    Option.isSome(kind.tryRecognize(url, method)) ? [name] : []
  )

/** A GET, and a request with no method, as every Recorder capture reaches the kinds. */
const METHODS = [
  { label: 'a GET', method: Option.some<HttpMethod>('GET') },
  { label: 'no method', method: Option.none<HttpMethod>() },
]

/** Any id the portal could key a URL by, reserved URL characters included. */
const portalIdArbitrary = fc.oneof(
  fc.uuid({ version: 4 }),
  fc.string({ minLength: 1, maxLength: 40 })
)

const RUNS = numRunsFor({ base: 100 })

describe('portal URLs', () => {
  it('builds the portal API URLs for a uuid', () => {
    const id = 'a7353645-83bf-4371-8b87-486b3d5b9802'
    expect(SHOPPERS_API_BASE_URL).toBe('https://mypharmacy.shoppersdrugmart.ca/api/v1')
    expect(customerUrlOf(id)).toBe(`${SHOPPERS_API_BASE_URL}/customers/pcid/${id}`)
    expect(prescriptionStatusUrlOf(id)).toBe(
      `${SHOPPERS_API_BASE_URL}/prescriptions/${id}/prescription-status`
    )
    expect(prescriptionHistoryUrlOf(id)).toBe(
      `${SHOPPERS_API_BASE_URL}/prescription-history?customerId=${id}`
    )
  })

  describe.each(METHODS)('for $label', ({ method }) => {
    it('property: customerUrlOf is recognized by CustomerResponseKind alone, with or without a query', () => {
      fc.assert(
        fc.property(portalIdArbitrary, (pcid) => {
          expect(recognizersOf(customerUrlOf(pcid), method)).toEqual(['customer'])
          expect(recognizersOf(`${customerUrlOf(pcid)}?expand=patients`, method)).toEqual([
            'customer',
          ])
        }),
        { numRuns: RUNS }
      )
    })

    it('property: prescriptionStatusUrlOf is recognized by PrescriptionResponseKind alone', () => {
      fc.assert(
        fc.property(portalIdArbitrary, (prescriptionId) => {
          expect(recognizersOf(prescriptionStatusUrlOf(prescriptionId), method)).toEqual([
            'prescription',
          ])
        }),
        { numRuns: RUNS }
      )
    })

    it('property: prescriptionHistoryUrlOf is recognized by PrescriptionHistoryResponseKind alone', () => {
      fc.assert(
        fc.property(portalIdArbitrary, (customerId) => {
          expect(recognizersOf(prescriptionHistoryUrlOf(customerId), method)).toEqual(['history'])
        }),
        { numRuns: RUNS }
      )
    })
  })

  describe('portalGetMatcher', () => {
    const id = 'a7353645-83bf-4371-8b87-486b3d5b9802'

    it.each([
      { kind: CustomerResponseKind, url: customerUrlOf(id) },
      { kind: PrescriptionResponseKind, url: prescriptionStatusUrlOf(id) },
      { kind: PrescriptionHistoryResponseKind, url: prescriptionHistoryUrlOf(id) },
    ])("claims a GET of $kind.name's URL and no other verb", ({ kind, url }) => {
      const recognizes = (method: Option.Option<HttpMethod>): boolean =>
        Option.isSome(kind.tryRecognize(url, method))
      expect(recognizes(Option.some('GET'))).toBe(true)
      expect(recognizes(Option.some('PUT'))).toBe(false)
      expect(recognizes(Option.some('OPTIONS'))).toBe(false)
      // The Recorder writes every method as UNKNOWN, which the archive drops.
      expect(recognizes(Option.none())).toBe(true)
    })
  })

  describe('tryPcidFromUrlParam', () => {
    it("property: reads the same pcid from an account's customers and history URLs", () => {
      fc.assert(
        fc.property(portalIdArbitrary, (pcid) => {
          expect(tryPcidFromUrlParam(customerUrlOf(pcid))).toStrictEqual(Option.some(pcid))
          expect(tryPcidFromUrlParam(`${customerUrlOf(pcid)}?expand=patients`)).toStrictEqual(
            Option.some(pcid)
          )
          expect(tryPcidFromUrlParam(prescriptionHistoryUrlOf(pcid))).toStrictEqual(
            Option.some(pcid)
          )
        }),
        { numRuns: RUNS }
      )
    })

    it.each([
      { label: 'in the customers path', url: `${SHOPPERS_API_BASE_URL}/customers/pcid/a+b` },
      {
        label: 'in the history query',
        url: `${SHOPPERS_API_BASE_URL}/prescription-history?customerId=a+b`,
      },
    ])('reads a raw + as itself $label', ({ url }) => {
      expect(tryPcidFromUrlParam(url)).toStrictEqual(Option.some('a+b'))
    })

    it('reads customerId wherever it sits in the history query', () => {
      expect(
        tryPcidFromUrlParam(`${SHOPPERS_API_BASE_URL}/prescription-history?lang=en&customerId=abc`)
      ).toStrictEqual(Option.some('abc'))
    })

    it.each([
      {
        label: 'an id that does not decode',
        url: `${SHOPPERS_API_BASE_URL}/customers/pcid/%E0%A4%A`,
      },
      { label: 'a status URL', url: prescriptionStatusUrlOf('rx-uuid-1') },
      { label: 'a customers sub-resource', url: `${customerUrlOf('abc')}/toasts` },
      {
        label: "another host's customers URL",
        url: 'https://example.org/api/v1/customers/pcid/abc',
      },
    ])('reads no pcid from $label', ({ url }) => {
      expect(tryPcidFromUrlParam(url)).toStrictEqual(Option.none())
    })
  })

  describe('tryDecodeUriComponent', () => {
    it('property: decodes what encodeURIComponent encodes', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          expect(tryDecodeUriComponent(encodeURIComponent(text))).toStrictEqual(Option.some(text))
        }),
        { numRuns: RUNS }
      )
    })

    it('is None for a malformed percent-encoding', () => {
      expect(tryDecodeUriComponent('%E0%A4%A')).toStrictEqual(Option.none())
    })
  })
})
