import { Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as Observation from '../resources/observation/observation.ts'
import { narrowFields } from './narrow-fields.ts'

describe('narrowFields', () => {
  it('should decode a value whose narrowed fields hold, typed as narrowed', () => {
    fc.assert(
      fc.property(fc.nat(), (count) => {
        // Act
        const decoded = Schema.decodeUnknownSync(CountedObservation)({
          ...decodedObservation,
          valueInteger: count,
        })

        // Assert: `valueInteger` is a `number` here, not `number | null`.
        const narrowed: number = decoded.valueInteger
        expect(narrowed).toBe(count)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should refuse a value whose narrowed field does not hold, naming the field', () => {
    fc.assert(
      fc.property(fc.constantFrom(null, -1, 2.5), (valueInteger) => {
        // Act
        const decoded = Schema.decodeUnknownEither(CountedObservation)({
          ...decodedObservation,
          valueInteger,
        })

        // Assert
        expect(Either.isLeft(decoded)).toBe(true)
        expect(Either.match(decoded, { onLeft: (e) => e.message, onRight: () => '' })).toContain(
          'valueInteger'
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should keep the choice-element guard of the schema it narrows', () => {
    // Act
    const decoded = Schema.decodeUnknownEither(CountedObservation)({
      ...decodedObservation,
      valueInteger: 5,
      valueString: 'five',
    })

    // Assert
    expect(Either.match(decoded, { onLeft: (e) => e.message, onRight: () => '' })).toContain(
      'choice element value[x] allows at most one populated slot, but found 2: valueString, valueInteger'
    )
  })
})

// Helpers

const CountedObservation = narrowFields(Schema.typeSchema(Observation.Schema), {
  valueInteger: Schema.NonNegativeInt,
})

const decodedObservation = Schema.decodeUnknownSync(Observation.Schema)({
  resourceType: 'Observation',
  status: 'final',
  code: { text: 'Push-ups' },
})
