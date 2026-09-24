import * as fc from 'fast-check'
import type { MedicationRequest } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { rexallStoreUrlOf, shoppersStoreUrlOf } from './store-url.ts'
import { base, decode } from './test-helpers.ts'

describe('rexallStoreUrlOf / shoppersStoreUrlOf', () => {
  it('should attribute a performer reference to exactly the chain whose base it is under', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(REXALL_STORE_BASE, SHOPPERS_STORE_BASE),
        fc.stringMatching(/^[0-9]{1,6}$/),
        (storeBase, storeId) => {
          const url = `${storeBase}${storeId}`
          const request = withPerformer(url)
          const isRexall = storeBase === REXALL_STORE_BASE
          expect(rexallStoreUrlOf(request)).toBe(isRexall ? url : null)
          expect(shoppersStoreUrlOf(request)).toBe(isRexall ? null : url)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should read no store from a performer reference under neither base', () => {
    fc.assert(
      fc.property(fc.oneof(fc.webUrl(), fc.constant('Organization/9')), (reference) => {
        fc.pre(!reference.startsWith(REXALL_STORE_BASE))
        fc.pre(!reference.startsWith(SHOPPERS_STORE_BASE))
        const request = withPerformer(reference)
        expect(rexallStoreUrlOf(request)).toBeNull()
        expect(shoppersStoreUrlOf(request)).toBeNull()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const REXALL_STORE_BASE = 'https://www.rexall.ca/storelocator/store/'
const SHOPPERS_STORE_BASE = 'https://www.shoppersdrugmart.ca/store-locator/store/'

const withPerformer = (reference: string): MedicationRequest.Type =>
  decode({ ...base, dispenseRequest: { performer: { reference } } })
