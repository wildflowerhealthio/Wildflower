import { Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { numRunsFor } from '../test/num-runs-for.ts'
import { modifyIfDecodes } from './modify-if-decodes.ts'

describe('modifyIfDecodes', () => {
  it('should edit input that decodes through the schema', () => {
    // Arrange
    const withDose = modifyIfDecodes(Medication, (medication) => ({ ...medication, dose: '20 mg' }))

    // Act
    const edited = withDose({ resourceType: 'Medication', name: 'Atorvastatin' })

    // Assert
    expect(edited).toEqual({ resourceType: 'Medication', name: 'Atorvastatin', dose: '20 mg' })
  })

  it('should write the edited value back in its encoded shape', () => {
    // Arrange
    const withDose = modifyIfDecodes(MedicationWithDoseOption, (medication) => ({
      ...medication,
      dose: Option.some('20 mg'),
    }))

    // Act
    const edited = withDose({ resourceType: 'Medication', name: 'Atorvastatin', dose: null })

    // Assert
    expect(edited).toEqual({ resourceType: 'Medication', name: 'Atorvastatin', dose: '20 mg' })
  })

  it('should return input that does not decode exactly as it went in', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        // Arrange
        fc.pre(!Schema.is(Medication)(input))
        const edit = modifyIfDecodes(Medication, (medication) => ({ ...medication, dose: 'x' }))

        // Act
        const result = edit(input)

        // Assert
        expect(result).toBe(input)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** A minimal resource-like shape: only a `Medication` is the kind the edit applies to. */
const Medication = Schema.Struct({
  resourceType: Schema.Literal('Medication'),
  name: Schema.String,
  dose: Schema.optional(Schema.String),
})

/** The same shape with a nullable `dose` decoded to an `Option`, so decoded and encoded differ. */
const MedicationWithDoseOption = Schema.Struct({
  resourceType: Schema.Literal('Medication'),
  name: Schema.String,
  dose: Schema.optionalWith(Schema.String, { nullable: true, as: 'Option' }),
})
