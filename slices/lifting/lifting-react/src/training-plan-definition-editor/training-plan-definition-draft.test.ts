import { StrongLifts5x5 } from 'lifting-core'
import { describe, expect, it } from 'vite-plus/test'

import {
  draftFromTrainingPlanDefinition,
  newDayDraft,
  newExerciseDraft,
} from './training-plan-definition-draft.ts'

describe('the new rows', () => {
  it('should label a new day with the first letter no day has', () => {
    expect(
      [...strongLiftsDraft.days, newDayDraft(strongLiftsDraft)].map(({ label }) => label)
    ).toEqual(['A', 'B', 'C'])
  })

  it('should key a new day and a new exercise row apart from every row of the draft', () => {
    const takenKeys = strongLiftsDraft.days.flatMap((dayDraft) => [
      dayDraft.key,
      ...dayDraft.exercises.map(({ key }) => key),
    ])

    expect(takenKeys).not.toContain(newDayDraft(strongLiftsDraft).key)
    expect(takenKeys).not.toContain(newExerciseDraft(strongLiftsDraft).key)
  })
})

// Helpers

const strongLiftsDraft = draftFromTrainingPlanDefinition(
  StrongLifts5x5.trainingPlanDefinition('plan-1')
)
