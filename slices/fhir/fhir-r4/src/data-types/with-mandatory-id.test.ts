import { Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as Observation from '../resources/observation/observation.ts'
import { withMandatoryId } from './with-mandatory-id.ts'

describe('withMandatoryId', () => {
  it('should decode a resource that carries an id', () => {
    // Arrange
    const wire = { ...minimalObservation, id: 'obs-7', valueString: 'Negative' }

    // Act
    const decoded = Schema.decodeUnknownSync(ObservationWithId)(wire)

    // Assert
    expect(decoded.id).toBe('obs-7')
  })

  it('should reject a resource without an id', () => {
    // Arrange
    const wire = { ...minimalObservation, valueString: 'Negative' }

    // Act
    const decoded = Schema.decodeUnknownEither(ObservationWithId)(wire)

    // Assert
    expect(Either.isLeft(decoded)).toBe(true)
  })

  it('should keep the choice-element guard of the schema it narrows', () => {
    // Arrange
    const wire = { ...minimalObservation, id: 'obs-7', valueString: 'hi', valueInteger: 5 }

    // Act
    const message = Either.match(Schema.decodeUnknownEither(ObservationWithId)(wire), {
      onLeft: (error) => error.message,
      onRight: () => 'decoded without error',
    })

    // Assert
    expect(message).toContain(
      'choice element value[x] allows at most one populated slot, but found 2: valueString, valueInteger'
    )
  })

  it('should reject encoding any resource populating two choice slots', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.integer(), (id, text, count) => {
        // Arrange
        const decoded = Schema.decodeUnknownSync(ObservationWithId)({ ...minimalObservation, id })
        const conflicting = { ...decoded, valueString: text, valueInteger: count }

        // Act
        const encoded = Schema.encodeEither(ObservationWithId)(conflicting)

        // Assert
        expect(Either.isLeft(encoded)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const ObservationWithId = withMandatoryId(Observation.Schema)

const minimalObservation = {
  resourceType: 'Observation',
  status: 'final',
  code: { text: 'Influenza A antigen' },
}
