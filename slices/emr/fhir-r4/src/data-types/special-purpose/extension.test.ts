import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

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

describe('hasUrl', () => {
  it('should hold for an extension at the queried url', () => {
    fc.assert(
      fc.property(bareExtension, fc.string(), (extension, url) => {
        // Arrange
        const atUrl = { ...extension, url }

        // Act
        const matches = Extension.hasUrl(url)(atUrl)

        // Assert
        expect(matches).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never hold for an extension at another url', () => {
    fc.assert(
      fc.property(
        bareExtension,
        fc.uniqueArray(fc.string(), { minLength: 2, maxLength: 2 }),
        (extension, [own = '', queried = '']) => {
          // Arrange
          const atOwnUrl = { ...extension, url: own }

          // Act
          const matches = Extension.hasUrl(queried)(atOwnUrl)

          // Assert
          expect(matches).toBe(false)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** An arbitrary Extension with no nested extensions, which keep generation tractable. */
const bareExtension = Arbitrary.make(Extension.Schema).map((extension) => ({
  ...extension,
  extension: [],
}))
