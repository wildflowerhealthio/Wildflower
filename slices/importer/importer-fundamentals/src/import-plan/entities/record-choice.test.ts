import { HashSet } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { stored, storedBrown, storedTyra, tyraWire } from '../import-plan.test-helpers.ts'
import * as RecordChoice from './record-choice.ts'

/** Covers what a record choice says of itself: whether it takes nothing, and when two are one. */

/** Use `existing`, taking `fields`. */
const useExisting = (
  existing: typeof storedTyra,
  ...fields: readonly string[]
): RecordChoice.Type =>
  RecordChoice.UseExistingRecord({ existing, fieldsTaken: HashSet.fromIterable(fields) })

describe('RecordChoice.takesNothing', () => {
  it('should hold only a use-existing choice that takes no field to take nothing', () => {
    // Arrange / Act
    const takesNothing = [
      useExisting(storedTyra),
      useExisting(storedTyra, 'gender'),
      RecordChoice.SaveAsNewRecord(),
      RecordChoice.DontAdd(),
    ].map(RecordChoice.takesNothing)

    // Assert
    expect(takesNothing).toEqual([true, false, false, false])
  })
})

describe('RecordChoice.equivalence', () => {
  it('should hold two use-existing choices one when they name one stored record by literal reference and take the same fields', () => {
    // Arrange
    const tyraAsReadAgain = stored({ ...tyraWire('tyra', { gender: 'female' }), id: 'p-1' })

    // Act
    const equivalent = RecordChoice.equivalence(
      useExisting(storedTyra, 'gender', 'birthDate'),
      useExisting(tyraAsReadAgain, 'birthDate', 'gender')
    )

    // Assert
    expect(equivalent).toBe(true)
  })

  it('should hold two use-existing choices apart when their stored records or their fields differ', () => {
    // Arrange
    const tyraTakingGender = useExisting(storedTyra, 'gender')

    // Act / Assert
    expect([
      RecordChoice.equivalence(tyraTakingGender, useExisting(storedBrown, 'gender')),
      RecordChoice.equivalence(tyraTakingGender, useExisting(storedTyra)),
    ]).toEqual([false, false])
  })

  it('should hold two choices of any other kind one by their kind alone', () => {
    // Arrange / Act
    const equivalent = [
      RecordChoice.equivalence(RecordChoice.SaveAsNewRecord(), RecordChoice.SaveAsNewRecord()),
      RecordChoice.equivalence(RecordChoice.DontAdd(), RecordChoice.DontAdd()),
      RecordChoice.equivalence(RecordChoice.SaveAsNewRecord(), RecordChoice.DontAdd()),
      RecordChoice.equivalence(RecordChoice.DontAdd(), useExisting(storedTyra)),
    ]

    // Assert
    expect(equivalent).toEqual([true, true, false, false])
  })
})
