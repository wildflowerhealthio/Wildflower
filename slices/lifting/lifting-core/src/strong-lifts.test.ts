import { Either, Record } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { exerciseIdFromName, makePlan } from './plan.ts'
import {
  STRONGLIFTS_5X5_INPUT,
  STRONGLIFTS_EXERCISES,
  STRONGLIFTS_STARTING_LOADS_LB,
  strongLifts5x5,
} from './strong-lifts.ts'

const LIFTS = Record.keys(STRONGLIFTS_EXERCISES)

describe('strongLifts5x5', () => {
  it('should be built from a literal makePlan accepts', () => {
    expect(Either.isRight(makePlan(STRONGLIFTS_5X5_INPUT))).toBe(true)
    expect(strongLifts5x5()).toEqual(Either.getOrThrow(makePlan(STRONGLIFTS_5X5_INPUT)))
  })

  it('should alternate A (squat, bench, row) with B (squat, press, deadlift)', () => {
    expect(strongLifts5x5().workouts).toEqual([
      { label: 'A', exerciseIds: ['squat', 'bench-press', 'barbell-row'] },
      { label: 'B', exerciseIds: ['squat', 'overhead-press', 'deadlift'] },
    ])
  })

  it('should prescribe 5×5 at +5 lb for every lift but the deadlift, which is 1×5 at +10 lb', () => {
    expect(
      Record.map(strongLifts5x5().goalsByExerciseId, (goal) => [
        goal.sets,
        goal.reps,
        goal.progression.incrementLb,
      ])
    ).toEqual({
      squat: [5, 5, 5],
      'bench-press': [5, 5, 5],
      'barbell-row': [5, 5, 5],
      'overhead-press': [5, 5, 5],
      deadlift: [1, 5, 10],
    })
  })

  it('should deload every lift by 10% after three failures, in 5 lb steps, never below the bar', () => {
    for (const goal of Record.values(strongLifts5x5().goalsByExerciseId)) {
      expect(goal.progression).toMatchObject({
        failuresBeforeDeload: 3,
        deloadFraction: 0.1,
        minimumLoadLb: 45,
        loadStepLb: 5,
      })
    }
  })

  it('should start as the StrongLifts guide does: the bar, 65 lb rows, 95 lb deadlifts', () => {
    expect(Record.map(strongLifts5x5().goalsByExerciseId, (goal) => goal.loadLb)).toEqual(
      STRONGLIFTS_STARTING_LOADS_LB
    )
    expect(STRONGLIFTS_STARTING_LOADS_LB).toEqual({
      squat: 45,
      'bench-press': 45,
      'barbell-row': 65,
      'overhead-press': 45,
      deadlift: 95,
    })
  })

  it('should key each lift by the slug of its name, and hold one goal per lift', () => {
    const { goalsByExerciseId } = strongLifts5x5()
    expect(Record.keys(goalsByExerciseId).toSorted()).toEqual([...LIFTS].toSorted())
    for (const lift of LIFTS) {
      const exercise = STRONGLIFTS_EXERCISES[lift]
      expect(exercise.id).toBe(lift)
      expect(exerciseIdFromName(exercise.name)).toBe(lift)
      expect(goalsByExerciseId[lift]?.exercise).toEqual(exercise)
    }
  })
})
