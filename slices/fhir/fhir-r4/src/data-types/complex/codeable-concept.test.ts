import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, Option, Schema } from 'effect'
import * as fc from 'fast-check'
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

describe('make', () => {
  it('should be one coding under the system, with its display, and the text', () => {
    fc.assert(
      fc.property(
        fc.webUrl(),
        fc.string(),
        fc.option(fc.string()),
        fc.option(fc.string()),
        (system, code, display, text) => {
          // Act
          const concept = CodeableConcept.make({ system, code, display, text })

          // Assert
          expect(concept.text).toBe(text)
          expect(
            concept.coding.map((coding) => [coding.system?.href, coding.code, coding.display])
          ).toEqual([[new URL(system).href, code, display]])
          expect(
            Schema.decodeSync(CodeableConcept.Schema)(
              Schema.encodeSync(CodeableConcept.Schema)(concept)
            )
          ).toEqual(concept)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('onlyCodingIn', () => {
  it('should find the one coding under a system among others, and none when it is absent or repeated', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.webUrl(), {
          minLength: 2,
          maxLength: 4,
          selector: (url) => new URL(url).href,
        }),
        fc.string(),
        ([queried = '', ...others], code) => {
          // Arrange
          const [target] = CodeableConcept.make({
            system: queried,
            code,
            display: null,
            text: null,
          }).coding
          const rest = others.flatMap(
            (system) => CodeableConcept.make({ system, code, display: null, text: null }).coding
          )
          const conceptOf = (coding: typeof rest): CodeableConcept.Type => ({
            id: null,
            extension: [],
            coding,
            text: null,
          })
          if (target === undefined) throw new Error('make writes one coding')

          // Act / Assert
          expect(
            CodeableConcept.onlyCodingIn(conceptOf([...rest, target]), new URL(queried).href)
          ).toEqual(Option.some(target))
          expect(CodeableConcept.onlyCodingIn(conceptOf(rest), new URL(queried).href)).toEqual(
            Option.none()
          )
          expect(
            CodeableConcept.onlyCodingIn(
              conceptOf([target, ...rest, target]),
              new URL(queried).href
            )
          ).toEqual(Option.none())
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
