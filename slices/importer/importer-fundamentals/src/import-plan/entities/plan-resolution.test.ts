import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { samplePlan } from '../import-plan.test-helpers.ts'
import * as ImportedRecord from './imported-record.ts'
import * as PlanResolution from './plan-resolution.ts'
import * as PlannedRecord from './planned-record.ts'

/** Covers a resolved record's label: its choice's, or `Unneeded`, which writes nothing. */

describe('PlanResolution.makeRecord and makeUnneededRecord', () => {
  it('should label a record by its choice, or as unneeded with nothing written', () => {
    // Arrange
    const { records } = samplePlan()

    // Act
    const resolved = records.map((planned) => {
      const facts = {
        planned,
        id: Option.some('x'),
        resolved: ImportedRecord.resourceOf(planned.record),
      }
      return [
        PlanResolution.makeRecord(facts, Option.none()).label,
        PlanResolution.makeUnneededRecord(facts),
      ] as const
    })

    // Assert
    expect(
      resolved.map(([label, unneeded]) => [label, unneeded.label, Option.isNone(unneeded.written)])
    ).toEqual(records.map((planned) => [PlannedRecord.labelOf(planned), 'Unneeded', true]))
  })

  it('should list every label of a choice, then Unneeded', () => {
    // Arrange / Act
    const { labels } = PlanResolution

    // Assert
    expect(labels).toEqual(['Create', 'Update', 'LinkToExisting', 'DontAdd', 'Open', 'Unneeded'])
  })
})
