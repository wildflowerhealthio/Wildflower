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
})
