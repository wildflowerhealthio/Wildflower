import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { Address as StoreAddress } from 'emr-core/schemas'

import * as Address from './address.ts'

describe('FhirR4Address', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(StoreAddress.Schema), (address) => {
        const fhir = Schema.encodeSync(Address.Schema)(address)
        const decoded = Schema.decodeSync(Address.Schema)(fhir)
        expect(decoded).toSchemaEqual(StoreAddress.Schema, address)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
