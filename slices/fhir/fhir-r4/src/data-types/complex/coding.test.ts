import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import * as Coding from './coding.ts'

describe('FhirR4Coding', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(Coding.Schema), (coding) => {
        const fhir = Schema.encodeSync(Coding.Schema)(coding)
        const decoded = Schema.decodeSync(Coding.Schema)(fhir)
        expect(decoded).toSchemaEqual(Coding.Schema, coding)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('isInSystem', () => {
  it('should hold for a coding under the queried system', () => {
    fc.assert(
      fc.property(Arbitrary.make(Coding.Schema), fc.webUrl(), (coding, system) => {
        // Arrange
        const inSystem = { ...coding, system: new URL(system) }

        // Act
        const matches = Coding.isInSystem(inSystem.system.href)(inSystem)

        // Assert
        expect(matches).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never hold for a coding under another system', () => {
    fc.assert(
      fc.property(
        Arbitrary.make(Coding.Schema),
        fc.uniqueArray(fc.webUrl(), {
          minLength: 2,
          maxLength: 2,
          selector: (url) => new URL(url).href,
        }),
        (coding, [own = '', queried = '']) => {
          // Arrange
          const inOwnSystem = { ...coding, system: new URL(own) }

          // Act
          const matches = Coding.isInSystem(new URL(queried).href)(inOwnSystem)

          // Assert
          expect(matches).toBe(false)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never hold for a coding with no system', () => {
    fc.assert(
      fc.property(Arbitrary.make(Coding.Schema), fc.string(), (coding, system) => {
        // Arrange
        const systemless = { ...coding, system: null }

        // Act
        const matches = Coding.isInSystem(system)(systemless)

        // Assert
        expect(matches).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
