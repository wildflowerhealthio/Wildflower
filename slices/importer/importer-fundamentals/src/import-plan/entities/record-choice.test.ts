import { HashSet } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { stored, storedBrown, storedTyra, tyraWire } from '../import-plan.test-helpers.ts'
import * as Difference from './difference.ts'
import * as RecordChoice from './record-choice.ts'

/**
 * Covers what a record choice says of itself: whether it takes no field, and
 * when two are one; and the three merges a reviewer moves between.
 */

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

/** A difference on one of a Patient's fields, filling a gap or overwriting a value. */
const differenceArbitrary: fc.Arbitrary<Difference.Type> = fc
  .record({
    field: fc.constantFrom('gender', 'birthDate', 'name', 'telecom', 'address'),
    fillsGap: fc.boolean(),
  })
  .map(({ field, fillsGap }) =>
    fillsGap ? Difference.FillsGap({ field }) : Difference.Overwrites({ field })
  )

/** A merge's stored record and the fields it takes, sorted, for a whole-value assertion. */
const mergeSummaryOf = (choice: RecordChoice.Type): unknown =>
  RecordChoice.is('MergeIntoExistingRecord')(choice)
    ? { existing: choice.existing, fieldsTaken: [...HashSet.values(choice.fieldsTaken)].toSorted() }
    : choice._tag

/** The fields of `differences`, sorted. */
const sortedFieldsOf = (differences: readonly Difference.Type[]): readonly string[] =>
  differences.map(({ field }) => field).toSorted()

describe('RecordChoice.mergeFillingGaps, mergeTakingEveryField and mergeTakingNoField', () => {
  it('should merge into the existing record taking exactly the gap-filling fields, every differing field, or none', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(differenceArbitrary, { selector: ({ field }) => field }),
        (differences) => {
          // Arrange
          const gapFilling = differences.filter(Difference.is('FillsGap'))

          // Act
          const merges = [
            RecordChoice.mergeFillingGaps(storedTyra, differences),
            RecordChoice.mergeTakingEveryField(storedTyra, differences),
            RecordChoice.mergeTakingNoField(storedTyra),
          ].map(mergeSummaryOf)

          // Assert
          expect(merges).toEqual([
            { existing: storedTyra, fieldsTaken: sortedFieldsOf(gapFilling) },
            { existing: storedTyra, fieldsTaken: sortedFieldsOf(differences) },
            { existing: storedTyra, fieldsTaken: [] },
          ])
        }
      )
    )
  })

  it('should take no field from no gap-filling difference, no difference, or by itself', () => {
    // Arrange / Act
    const takesNoField = [
      RecordChoice.mergeFillingGaps(storedTyra, [Difference.Overwrites({ field: 'gender' })]),
      RecordChoice.mergeTakingEveryField(storedTyra, []),
      RecordChoice.mergeTakingNoField(storedTyra),
    ].map(RecordChoice.takesNoField)

    // Assert
    expect(takesNoField).toEqual([true, true, true])
  })
})
