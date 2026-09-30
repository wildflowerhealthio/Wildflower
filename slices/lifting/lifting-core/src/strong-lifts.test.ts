import { Either, Record } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { exerciseIdFromName, makePlan } from './plan.ts'
import { prescribe } from './prescription.ts'
import {
  STRONGLIFTS_5X5_INPUT,
  STRONGLIFTS_EXERCISES,
  STRONGLIFTS_STARTING_LOADS,
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

  it('should run 5×5 at +5 lb for every lift but the deadlift, which is 1×5 at +10 lb', () => {
    expect(
      Record.map(strongLifts5x5().exercisesById, (planned) => [
        planned.sets,
        planned.reps,
        planned.progression.increment,
        planned.progression.unit,
      ])
    ).toEqual({
      squat: [5, 5, 5, 'lb'],
      'bench-press': [5, 5, 5, 'lb'],
      'barbell-row': [5, 5, 5, 'lb'],
      'overhead-press': [5, 5, 5, 'lb'],
      deadlift: [1, 5, 10, 'lb'],
    })
  })

  it('should deload every lift by 10% after three failures, in 5 lb steps, never below the bar', () => {
    for (const planned of Record.values(strongLifts5x5().exercisesById)) {
      expect(planned.progression).toMatchObject({
        failuresBeforeDeload: 3,
        deloadFraction: 0.1,
        minimumLoad: 45,
        loadStep: 5,
      })
    }
  })

  it('should start as the StrongLifts guide does, at loads every lift accepts', () => {
    expect(STRONGLIFTS_STARTING_LOADS).toEqual({
      squat: { value: 45, unit: 'lb' },
      'bench-press': { value: 45, unit: 'lb' },
      'barbell-row': { value: 65, unit: 'lb' },
      'overhead-press': { value: 45, unit: 'lb' },
      deadlift: { value: 95, unit: 'lb' },
    })
    const plan = strongLifts5x5()
    for (const lift of LIFTS) {
      expect(prescribe(plan, lift, STRONGLIFTS_STARTING_LOADS[lift])).toEqual(
        Either.right({
          exercise: STRONGLIFTS_EXERCISES[lift],
          load: STRONGLIFTS_STARTING_LOADS[lift],
          sets: lift === 'deadlift' ? 1 : 5,
          reps: 5,
        })
      )
    }
  })

  it('should key each lift by the slug of its name, and plan each lift once', () => {
    const { exercisesById } = strongLifts5x5()
    expect(Record.keys(exercisesById).toSorted()).toEqual([...LIFTS].toSorted())
    for (const lift of LIFTS) {
      const exercise = STRONGLIFTS_EXERCISES[lift]
      expect(exercise.id).toBe(lift)
      expect(exerciseIdFromName(exercise.name)).toBe(lift)
      expect(exercisesById[lift]?.exercise).toEqual(exercise)
    }
  })
})
