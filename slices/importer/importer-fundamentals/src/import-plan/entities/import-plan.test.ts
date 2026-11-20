import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Equal, Option } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  afterSteps,
  drBrown,
  prescription,
  reviewerStepArbitrary,
  samplePlan,
  tyraA,
} from '../import-plan.test-helpers.ts'
import * as ImportPlan from './import-plan.ts'
import * as ImportedCopy from './imported-copy.ts'
import * as PlannedRecord from './planned-record.ts'
import * as RecordChoice from './record-choice.ts'
import * as RecordKey from './record-key.ts'

/**
 * Covers the plan's own transitions: reading a record by its key, the
 * reviewer's choice, a reset back to the suggestion, and an edit.
 */

const prescriptionKey = ImportedCopy.recordKeyOf(prescription)
const drBrownKey = ImportedCopy.recordKeyOf(drBrown)

/** The record under `key`, which the test's plan holds. */
const recordOf = (plan: ImportPlan.Type, key: RecordKey.Type): PlannedRecord.Type =>
  Option.getOrThrow(ImportPlan.get(plan, key))

describe('ImportPlan.get', () => {
  it('should read a record by its key, and nothing for a key the plan does not hold', () => {
    // Arrange
    const plan = samplePlan()

    // Act
    const found = ImportPlan.get(plan, ImportedCopy.recordKeyOf(tyraA))
    const missing = ImportPlan.get(plan, RecordKey.Keyless({ reviewKey: 'nowhere' }))

    // Assert
    expect({
      found: Option.map(found, ({ record }) => record.copies.map(({ reviewKey }) => reviewKey)),
      missing: Option.isNone(missing),
    }).toEqual({ found: Option.some(['a.har/tyra', 'b.pdf/tyra']), missing: true })
  })
})

describe('ImportPlan.choose, reset and setEdit', () => {
  it('should set the reviewer’s choice on the records under the keys given, and no other', () => {
    // Arrange
    const plan = samplePlan()

    // Act
    const chosen = ImportPlan.choose(plan, [prescriptionKey], RecordChoice.DontAdd())

    // Assert
    expect(
      chosen.records.map(({ chosen: choice }) => Option.map(choice, ({ _tag }) => _tag))
    ).toEqual([Option.none(), Option.some('DontAdd'), Option.none()])
  })

  it('should clear the reviewer’s choice on reset', () => {
    // Arrange
    const chosen = ImportPlan.choose(samplePlan(), [prescriptionKey], RecordChoice.DontAdd())

    // Act
    const reset = ImportPlan.reset(chosen, [prescriptionKey])

    // Assert
    expect(Option.isNone(recordOf(reset, prescriptionKey).chosen)).toBe(true)
  })

  it('should set and clear the edit of one record', () => {
    // Arrange
    const plan = samplePlan()

    // Act
    const edited = ImportPlan.setEdit(plan, drBrownKey, Option.some(drBrown.resource))
    const cleared = ImportPlan.setEdit(edited, drBrownKey, Option.none())

    // Assert
    expect({
      edited: Option.isSome(recordOf(edited, drBrownKey).edit),
      cleared: Option.isNone(recordOf(cleared, drBrownKey).edit),
    }).toEqual({ edited: true, cleared: true })
  })
})

describe('ImportPlan properties', () => {
  it('should restore every suggestion when each record is reset after the reviewer’s choices', () => {
    fc.assert(
      fc.property(fc.array(reviewerStepArbitrary), (steps) => {
        // Arrange
        const suggested = samplePlan()
        const reviewed = afterSteps(suggested, steps)

        // Act
        const reset = ImportPlan.reset(
          reviewed,
          reviewed.records.map(({ record }) => record.key)
        )

        // Assert
        expect(
          reset.records.every(
            (planned, index) =>
              Option.isNone(planned.chosen) &&
              !PlannedRecord.isChanged(planned) &&
              Equal.equals(planned.record.key, suggested.records[index]?.record.key) &&
              PlannedRecord.labelOf(planned) ===
                PlannedRecord.labelOf(suggested.records[index] ?? planned)
          )
        ).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
