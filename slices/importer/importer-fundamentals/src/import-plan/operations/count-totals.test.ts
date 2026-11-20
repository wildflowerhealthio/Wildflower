import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as ImportPlan from '../entities/import-plan.ts'
import * as ImportedCopy from '../entities/imported-copy.ts'
import * as PlanTotals from '../entities/plan-totals.ts'
import * as RecordChoice from '../entities/record-choice.ts'
import {
  afterSteps,
  drBrown,
  prescription,
  reviewerStepArbitrary,
  samplePlan,
} from '../import-plan.test-helpers.ts'
import { countTotals } from './count-totals.ts'
import { planWith, resolutionOf } from './resolve-plan.test-helpers.ts'

/**
 * Covers what counts where in a resolved plan: each label overall and per
 * file set, a record nothing written names as unneeded, and the records that
 * need a decision.
 */

describe('countTotals', () => {
  it('should count every record under its label overall and each file set the records it brought', () => {
    // Arrange
    const plan = samplePlan()

    // Act
    const totals = countTotals(resolutionOf(plan))

    // Assert
    expect({
      overall: totals.overall,
      fileSets: totals.fileSets.map(({ origin, counts }) => [
        origin.pickedFiles[0].fileName,
        counts,
      ]),
    }).toEqual({
      overall: {
        byLabel: { Create: 1, Update: 1, LinkToExisting: 1, DontAdd: 0, Open: 0, Unneeded: 0 },
        needsDecision: 1,
      },
      fileSets: [
        [
          'a.har',
          {
            byLabel: { Create: 1, Update: 1, LinkToExisting: 1, DontAdd: 0, Open: 0, Unneeded: 0 },
            needsDecision: 1,
          },
        ],
        [
          'b.pdf',
          {
            byLabel: { Create: 0, Update: 1, LinkToExisting: 0, DontAdd: 0, Open: 0, Unneeded: 0 },
            needsDecision: 0,
          },
        ],
      ],
    })
  })

  it('should count a record its choice would link that nothing written names as unneeded, and a label no record has as zero', () => {
    // Arrange
    const plan = ImportPlan.choose(
      samplePlan(),
      [ImportedCopy.recordKeyOf(prescription)],
      RecordChoice.DontAdd()
    )

    // Act
    const { overall } = countTotals(resolutionOf(plan))

    // Assert
    expect(overall.byLabel).toEqual({
      Create: 0,
      Update: 1,
      LinkToExisting: 0,
      DontAdd: 1,
      Open: 0,
      Unneeded: 1,
    })
  })

  it('should count a record saved as new that nothing written names as unneeded, never as created', () => {
    // Arrange
    const plan = planWith([prescription, drBrown], [[prescription, RecordChoice.DontAdd()]])

    // Act
    const { overall } = countTotals(resolutionOf(plan))

    // Assert
    expect(overall.byLabel).toMatchObject({ Create: 0, DontAdd: 1, Unneeded: 1 })
  })

  it('should count every record once overall, whatever the reviewer chooses', () => {
    fc.assert(
      fc.property(fc.array(reviewerStepArbitrary), (steps) => {
        // Arrange
        const plan = afterSteps(samplePlan(), steps)

        // Act
        const { overall } = countTotals(resolutionOf(plan))

        // Assert
        expect(PlanTotals.recordsOf(overall)).toBe(plan.records.length)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
