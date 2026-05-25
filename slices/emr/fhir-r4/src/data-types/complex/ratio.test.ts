import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Ratio as StoreRatio } from 'emr-core/schemas'

import * as Ratio from './ratio.ts'

describe('FhirR4Ratio', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(StoreRatio.Schema), (ratio) => {
        const fhir = Schema.encodeSync(Ratio.Schema)(ratio)
        const decoded = Schema.decodeSync(Ratio.Schema)(fhir)
        expect(decoded).toSchemaEqual(StoreRatio.Schema, ratio)
      })
    )
  })
})
