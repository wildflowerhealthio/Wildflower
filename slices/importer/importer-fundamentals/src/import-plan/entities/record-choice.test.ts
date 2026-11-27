import { HashSet } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { stored, storedBrown, storedTyra, tyraWire } from '../import-plan.test-helpers.ts'
import * as RecordChoice from './record-choice.ts'

/** Covers what a record choice says of itself: whether it takes no field, and when two are one. */

/** Merge into `existing`, taking `fields`. */
const mergeInto = (existing: typeof storedTyra, ...fields: readonly string[]): RecordChoice.Type =>
  RecordChoice.MergeIntoExistingRecord({ existing, fieldsTaken: HashSet.fromIterable(fields) })

describe('RecordChoice.takesNoField', () => {
  it('should hold only a merge into an existing record that takes no field to take no field', () => {
    // Arrange / Act
    const takesNoField = [
      mergeInto(storedTyra),
      mergeInto(storedTyra, 'gender'),
      RecordChoice.SaveAsNewRecord(),
      RecordChoice.DontAdd(),
    ].map(RecordChoice.takesNoField)

    // Assert
    expect(takesNoField).toEqual([true, false, false, false])
  })
})

describe('RecordChoice.equivalence', () => {
  it('should hold two merges into an existing record one when they name one stored record by literal reference and take the same fields', () => {
    // Arrange
    const tyraAsReadAgain = stored({ ...tyraWire('tyra', { gender: 'female' }), id: 'p-1' })

    // Act
    const equivalent = RecordChoice.equivalence(
      mergeInto(storedTyra, 'gender', 'birthDate'),
      mergeInto(tyraAsReadAgain, 'birthDate', 'gender')
    )

    // Assert
    expect(equivalent).toBe(true)
  })

  it('should hold two merges into an existing record apart when their stored records or their fields differ', () => {
    // Arrange
    const tyraTakingGender = mergeInto(storedTyra, 'gender')

    // Act / Assert
    expect([
      RecordChoice.equivalence(tyraTakingGender, mergeInto(storedBrown, 'gender')),
      RecordChoice.equivalence(tyraTakingGender, mergeInto(storedTyra)),
    ]).toEqual([false, false])
  })

  it('should hold two choices of any other kind one by their kind alone', () => {
    // Arrange / Act
    const equivalent = [
      RecordChoice.equivalence(RecordChoice.SaveAsNewRecord(), RecordChoice.SaveAsNewRecord()),
      RecordChoice.equivalence(RecordChoice.DontAdd(), RecordChoice.DontAdd()),
      RecordChoice.equivalence(RecordChoice.SaveAsNewRecord(), RecordChoice.DontAdd()),
      RecordChoice.equivalence(RecordChoice.DontAdd(), mergeInto(storedTyra)),
    ]

    // Assert
    expect(equivalent).toEqual([true, true, false, false])
  })
})
