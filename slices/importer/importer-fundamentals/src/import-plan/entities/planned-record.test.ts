import { HashSet, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  detached,
  drBrown,
  drBrownWire,
  plannedOf,
  prescription,
  samplePlan,
  storedBrown,
} from '../import-plan.test-helpers.ts'
import * as ImportPlan from './import-plan.ts'
import * as ImportedCopy from './imported-copy.ts'
import * as ImportedRecord from './imported-record.ts'
import * as PlannedRecord from './planned-record.ts'
import * as RecordChoice from './record-choice.ts'
import type * as RecordKey from './record-key.ts'
import * as Suggestion from './suggestion.ts'

/**
 * Covers what a planned record says of itself: its effective choice, its
 * label, whether it needs a decision, and whether the reviewer changed it.
 */

const prescriptionKey = ImportedCopy.recordKeyOf(prescription)
const drBrownKey = ImportedCopy.recordKeyOf(drBrown)

/** The record under `key` in `plan`. */
const recordOf = (plan: ImportPlan.Type, key: RecordKey.Type): PlannedRecord.Type =>
  Option.getOrThrow(ImportPlan.get(plan, key))

describe('PlannedRecord.labelOf', () => {
  it('should label each suggested record by its effective choice', () => {
    // Arrange / Act
    const labels = samplePlan().records.map(PlannedRecord.labelOf)

    // Assert
    expect(labels).toEqual(['Update', 'Create', 'LinkToExisting'])
  })

  it('should label a record the reviewer does not add DontAdd', () => {
    // Arrange / Act
    const chosen = ImportPlan.choose(samplePlan(), [prescriptionKey], RecordChoice.DontAdd())

    // Assert
    expect(PlannedRecord.labelOf(recordOf(chosen, prescriptionKey))).toBe('DontAdd')
  })

  it('should label a linked record Update once it is edited', () => {
    // Arrange / Act
    const edited = ImportPlan.setEdit(samplePlan(), drBrownKey, Option.some(drBrown.resource))

    // Assert
    expect(PlannedRecord.labelOf(recordOf(edited, drBrownKey))).toBe('Update')
  })

  it('should label a record whose choice is undecided Open', () => {
    // Arrange
    const undecided = plannedOf(
      [drBrown],
      Suggestion.make(Option.none(), Suggestion.NameMatchReferenced())
    )

    // Act
    const label = PlannedRecord.labelOf(undecided)

    // Assert
    expect(label).toBe('Open')
  })
})

describe('PlannedRecord.needsDecision', () => {
  it('should list a record under Needs a decision by its suggestion’s reason alone', () => {
    // Arrange / Act
    const needsDecision = samplePlan().records.map(PlannedRecord.needsDecision)

    // Assert
    expect(needsDecision).toEqual([false, false, true])
  })
})

describe('PlannedRecord.isChanged', () => {
  it('should mark a record changed when the reviewer chooses other than the suggestion', () => {
    // Arrange / Act
    const chosen = ImportPlan.choose(samplePlan(), [prescriptionKey], RecordChoice.DontAdd())

    // Assert
    expect(PlannedRecord.isChanged(recordOf(chosen, prescriptionKey))).toBe(true)
  })

  it('should not mark a record changed when the reviewer chooses what was suggested', () => {
    // Arrange / Act
    const chosen = ImportPlan.choose(
      samplePlan(),
      [drBrownKey],
      RecordChoice.MergeIntoExistingRecord({ existing: storedBrown, fieldsTaken: HashSet.empty() })
    )

    // Assert
    expect(PlannedRecord.isChanged(recordOf(chosen, drBrownKey))).toBe(false)
  })
})

describe('PlannedRecord.withChoice, withChoiceCleared and withEdit', () => {
  it('should set the reviewer’s choice over the suggestion, and clear it back to the suggestion', () => {
    // Arrange
    const suggested = recordOf(samplePlan(), prescriptionKey)

    // Act
    const chosen = PlannedRecord.withChoice(suggested, RecordChoice.DontAdd())
    const cleared = PlannedRecord.withChoiceCleared(chosen)

    // Assert
    expect([PlannedRecord.effectiveChoice(chosen), PlannedRecord.effectiveChoice(cleared)]).toEqual(
      [Option.some(RecordChoice.DontAdd()), suggested.suggestion.choice]
    )
    expect(cleared).toEqual(suggested)
  })

  it('should set the reviewer’s edit, and clear it by none, leaving the choice alone', () => {
    // Arrange
    const chosen = PlannedRecord.withChoice(
      recordOf(samplePlan(), drBrownKey),
      RecordChoice.SaveAsNewRecord()
    )

    // Act
    const edited = PlannedRecord.withEdit(chosen, Option.some(drBrown.resource))
    const unedited = PlannedRecord.withEdit(edited, Option.none())

    // Assert
    expect([edited.edit, edited.chosen]).toEqual([Option.some(drBrown.resource), chosen.chosen])
    expect(unedited).toEqual(chosen)
  })
})

describe('PlannedRecord.reviewedResourceOf', () => {
  it('should be the reviewer’s edit when there is one, else the record’s resource', () => {
    // Arrange
    const suggested = recordOf(samplePlan(), drBrownKey)
    const edit = detached({ ...drBrownWire, name: [{ text: 'Dr. J. Brown' }] })

    // Act
    const reviewed = [suggested, PlannedRecord.withEdit(suggested, Option.some(edit))].map(
      PlannedRecord.reviewedResourceOf
    )

    // Assert
    expect(reviewed).toEqual([ImportedRecord.resourceOf(suggested.record), edit])
  })
})
