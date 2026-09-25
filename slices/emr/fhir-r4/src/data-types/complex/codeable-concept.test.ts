import { Arbitrary, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import * as CodeableConcept from './codeable-concept.ts'

describe('FhirR4CodeableConcept', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(CodeableConcept.Schema), (codeableConcept) => {
        const fhir = Schema.encodeSync(CodeableConcept.Schema)(codeableConcept)
        const decoded = Schema.decodeSync(CodeableConcept.Schema)(fhir)
        expect(decoded).toSchemaEqual(CodeableConcept.Schema, codeableConcept)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('label', () => {
  it('should prefer the text the source wrote over a coding display', () => {
    // Arrange
    const concept = {
      text: 'Atorvastatin 20 mg tablet',
      coding: [{ display: 'Atorvastatin calcium' }],
    }

    // Act
    const conceptLabel = CodeableConcept.label(concept)

    // Assert
    expect(conceptLabel).toEqual(Option.some('Atorvastatin 20 mg tablet'))
  })

  it('should fall back to the first coding with a non-blank display', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined, ''),
        fc.string({ minLength: 1 }),
        (blankText, display) => {
          // Arrange — a blank display before the real one must be skipped.
          const concept = { text: blankText, coding: [{ display: '' }, { display }] }

          // Act
          const conceptLabel = CodeableConcept.label(concept)

          // Assert
          expect(conceptLabel).toEqual(Option.some(display))
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should have no label when neither text nor any display is present', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined, ''),
        fc.array(fc.record({ display: fc.constantFrom(null, undefined, '') })),
        (blankText, blankCodings) => {
          // Act
          const conceptLabel = CodeableConcept.label({ text: blankText, coding: blankCodings })

          // Assert
          expect(conceptLabel).toEqual(Option.none())
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
