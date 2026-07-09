import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

// side-effect: load Address so the registry's `valueAddress` slot resolves
import * as Address from '../complex/address.ts'
import * as Extension from './extension.ts'

describe('FhirR4Extension', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(
        Arbitrary.make(Extension.Schema).map((ext) => ({ ...ext, extension: [] })),
        (extension) => {
          const fhir = Schema.encodeSync(Extension.Schema)(extension)
          const decoded = Schema.decodeSync(Extension.Schema)(fhir)
          expect(decoded).toSchemaEqual(Extension.Schema, extension)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('encodes null choice fields to undefined, not null, on the wire', () => {
    fc.assert(
      fc.property(Arbitrary.make(Address.Schema), (address) => {
        const extension: typeof Extension.Schema.Type = {
          ...Extension.emptyValueChoice,
          id: null,
          extension: [],
          url: 'http://example.org/ext/home-address',
          valueAddress: address,
        }
        const encoded = Schema.encodeSync(Extension.Schema)(extension)
        const decoded = Schema.decodeSync(Extension.Schema)(encoded)
        expect(decoded).toSchemaEqual(Extension.Schema, extension)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
