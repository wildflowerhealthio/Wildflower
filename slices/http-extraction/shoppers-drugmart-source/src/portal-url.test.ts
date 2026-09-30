import { Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
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

/** The kinds that recognize `url`, by name. */
const recognizersOf = (url: string): readonly string[] =>
  Object.entries(KINDS).flatMap(([name, kind]) =>
    Option.isSome(kind.tryRecognize(url, Option.none())) ? [name] : []
  )

/** Any id the portal could key a URL by, reserved URL characters included. */
const portalIdArbitrary = fc.oneof(
  fc.uuid({ version: 4 }),
  fc.string({ minLength: 1, maxLength: 40 })
)

const RUNS = numRunsFor({ base: 100 })

describe('portal URLs', () => {
  it('builds the URLs the collector documents for a uuid', () => {
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

  it('property: customerUrlOf is recognized by CustomerResponseKind alone, with or without a query', () => {
    fc.assert(
      fc.property(portalIdArbitrary, (pcid) => {
        expect(recognizersOf(customerUrlOf(pcid))).toEqual(['customer'])
        expect(recognizersOf(`${customerUrlOf(pcid)}?expand=patients`)).toEqual(['customer'])
      }),
      { numRuns: RUNS }
    )
  })

  it('property: prescriptionStatusUrlOf is recognized by PrescriptionResponseKind alone', () => {
    fc.assert(
      fc.property(portalIdArbitrary, (prescriptionId) => {
        expect(recognizersOf(prescriptionStatusUrlOf(prescriptionId))).toEqual(['prescription'])
      }),
      { numRuns: RUNS }
    )
  })

  it('property: prescriptionHistoryUrlOf is recognized by PrescriptionHistoryResponseKind alone', () => {
    fc.assert(
      fc.property(portalIdArbitrary, (customerId) => {
        expect(recognizersOf(prescriptionHistoryUrlOf(customerId))).toEqual(['history'])
      }),
      { numRuns: RUNS }
    )
  })
})
