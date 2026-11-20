import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { samplePlan, stored, tyraWire } from '../import-plan.test-helpers.ts'
import * as ImportedRecord from './imported-record.ts'
import * as PlanResolution from './plan-resolution.ts'
import type * as PlannedRecord from './planned-record.ts'

/**
 * Covers a resolved record's label: its choice's, a record that merges into a
 * stored record's by whether anything is written for it, or `Unneeded`,
 * which writes nothing.
 */

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
    ).toEqual([
      ['LinkToExisting', 'Unneeded', true],
      ['Create', 'Unneeded', true],
      ['LinkToExisting', 'Unneeded', true],
    ])
  })

  it('should label a record that merges into a stored record Update when something is written for it, whatever its choice takes, and LinkToExisting when nothing is', () => {
    // Arrange
    const [tyra, , drBrown] = samplePlan().records
    if (tyra === undefined || drBrown === undefined)
      throw new Error('The sample plan has three records')
    const factsOf = (planned: PlannedRecord.Type): PlanResolution.RecordFacts => ({
      planned,
      id: Option.some('x'),
      resolved: ImportedRecord.resourceOf(planned.record),
    })
    const written = Option.some(stored({ ...tyraWire('tyra'), id: 'p-1' }))

    // Act
    const labels = [tyra, drBrown].flatMap((planned) => [
      PlanResolution.makeRecord(factsOf(planned), written).label,
      PlanResolution.makeRecord(factsOf(planned), Option.none()).label,
    ])

    // Assert
    expect(labels).toEqual(['Update', 'LinkToExisting', 'Update', 'LinkToExisting'])
  })

  it('should list every label of a choice, then Unneeded', () => {
    // Arrange / Act
    const { labels } = PlanResolution

    // Assert
    expect(labels).toEqual(['Create', 'Update', 'LinkToExisting', 'DontAdd', 'Open', 'Unneeded'])
  })
})
