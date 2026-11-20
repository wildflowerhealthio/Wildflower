import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Record } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { tyraA } from '../import-plan.test-helpers.ts'
import * as PlanResolution from './plan-resolution.ts'
import * as PlanTotals from './plan-totals.ts'

/** Covers how plan totals hold their counts: every label present, and how many records they count. */

/** A count for each label, as a test draws them. */
const countsByLabelArbitrary = fc.record(
  Record.fromIterableWith(PlanResolution.labels, (label) => [label, fc.nat({ max: 50 })] as const)
)

describe('PlanTotals.makeCounts', () => {
  it('should hold every label’s count, in label order, beside how many need a decision', () => {
    // Arrange
    const created = { Create: 3, Update: 2, LinkToExisting: 0, DontAdd: 1, Open: 4, Unneeded: 1 }

    // Act
    const counts = PlanTotals.makeCounts((label) => created[label], 5)

    // Assert
    expect(counts).toEqual({ byLabel: created, needsDecision: 5 })
    expect(Object.keys(counts.byLabel)).toEqual([...PlanResolution.labels])
  })

  it('should treat a count that is no number of records as a defect', () => {
    // Arrange / Act / Assert
    expect(() => PlanTotals.makeCounts((label) => (label === 'Open' ? -1 : 0), 0)).toThrow()
  })
})

describe('PlanTotals.recordsOf', () => {
  it('should count every record once, the sum of its labels’ counts', () => {
    fc.assert(
      fc.property(countsByLabelArbitrary, (byLabel) => {
        // Arrange
        const counts = PlanTotals.makeCounts((label) => byLabel[label], 0)

        // Act
        const records = PlanTotals.recordsOf(counts)

        // Assert
        expect(records).toBe(PlanResolution.labels.reduce((sum, label) => sum + byLabel[label], 0))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('PlanTotals.make and makeFileSetCounts', () => {
  it('should hold the overall counts beside each file set’s line, its origin and its counts', () => {
    // Arrange
    const overall = PlanTotals.makeCounts((label) => (label === 'Create' ? 2 : 0), 0)
    const fileSet = PlanTotals.makeCounts((label) => (label === 'Create' ? 1 : 0), 0)

    // Act
    const totals = PlanTotals.make(overall, [PlanTotals.makeFileSetCounts(tyraA.origin, fileSet)])

    // Assert
    expect(totals).toEqual({ overall, fileSets: [{ origin: tyraA.origin, counts: fileSet }] })
  })
})
