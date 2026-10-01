import { Either, Record } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as ExerciseRequest from '../exercise-request/exercise-request.ts'
import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import * as Load from '../load/load.ts'
import * as Plan from '../plan/plan.ts'
import * as PlannedExercise from '../plan/planned-exercise.ts'
import * as ProgressionRule from '../plan/progression-rule.ts'
import * as Workout from '../plan/workout.ts'
import { AUTHORED_ON, SUBJECT } from '../test-helpers.ts'
import * as StrongLifts5x5 from './strong-lifts.ts'

const LIFTS = Record.keys(StrongLifts5x5.EXERCISES)

describe('StrongLifts5x5', () => {
  it('should alternate A (squat, bench, row) with B (squat, press, deadlift)', () => {
    expect(
      Plan.workoutsOf(StrongLifts5x5.plan('plan-1')).map((workout) => [
        Workout.labelOf(workout),
        Workout.plannedExercisesOf(workout).map(PlannedExercise.exerciseIdOf),
      ])
    ).toEqual([
      ['A', ['squat', 'bench-press', 'barbell-row']],
      ['B', ['squat', 'overhead-press', 'deadlift']],
    ])
  })

  it('should run 5×5 at +5 lb for every lift but the deadlift, which is 1×5 at +10 lb', () => {
    expect(
      Plan.plannedExercisesOf(StrongLifts5x5.plan('plan-1')).map((planned) => [
        PlannedExercise.exerciseIdOf(planned),
        PlannedExercise.setsOf(planned),
        PlannedExercise.repsOf(planned),
        ProgressionRule.incrementOf(PlannedExercise.progressionRuleOf(planned)),
        ProgressionRule.unitOf(PlannedExercise.progressionRuleOf(planned)),
      ])
    ).toEqual([
      ['squat', 5, 5, 5, '[lb_av]'],
      ['bench-press', 5, 5, 5, '[lb_av]'],
      ['barbell-row', 5, 5, 5, '[lb_av]'],
      ['overhead-press', 5, 5, 5, '[lb_av]'],
      ['deadlift', 1, 5, 10, '[lb_av]'],
    ])
  })

  it('should deload every lift by 10% after three failures, in 5 lb steps, never below the bar', () => {
    for (const planned of Plan.plannedExercisesOf(StrongLifts5x5.plan('plan-1'))) {
      const rule = PlannedExercise.progressionRuleOf(planned)
      expect([
        ProgressionRule.failuresBeforeDeloadOf(rule),
        ProgressionRule.deloadFractionOf(rule),
        ProgressionRule.minimumLoadOf(rule),
        ProgressionRule.loadStepOf(rule),
      ]).toEqual([3, 0.1, 45, 5])
    }
  })

  it('should start as the StrongLifts guide does, at loads every lift accepts', () => {
    expect(
      Record.map(StrongLifts5x5.STARTING_LOADS, (load) => [Load.valueOf(load), Load.unitOf(load)])
    ).toEqual({
      squat: [45, '[lb_av]'],
      'bench-press': [45, '[lb_av]'],
      'barbell-row': [65, '[lb_av]'],
      'overhead-press': [45, '[lb_av]'],
      deadlift: [95, '[lb_av]'],
    })
    const plan = StrongLifts5x5.plan('plan-1')
    for (const lift of LIFTS) {
      const made = ExerciseRequest.make({
        serviceRequestId: `sr-${lift}`,
        subject: SUBJECT,
        plan,
        exerciseId: lift,
        load: StrongLifts5x5.STARTING_LOADS[lift],
        authoredOn: AUTHORED_ON,
      })
      expect(
        Either.map(made, (exerciseRequest) => [
          ExerciseConcept.idOf(ExerciseRequest.exerciseOf(exerciseRequest)),
          Load.valueOf(ExerciseRequest.loadOf(exerciseRequest)),
          ExerciseRequest.setsOf(exerciseRequest),
          ExerciseRequest.repsOf(exerciseRequest),
        ])
      ).toEqual(
        Either.right([
          lift,
          Load.valueOf(StrongLifts5x5.STARTING_LOADS[lift]),
          lift === 'deadlift' ? 1 : 5,
          5,
        ])
      )
    }
  })

  it('should key each lift by the slug of its name', () => {
    for (const lift of LIFTS) {
      const exercise = StrongLifts5x5.EXERCISES[lift]
      expect(ExerciseConcept.idOf(exercise)).toBe(lift)
      expect(ExerciseConcept.idFromName(ExerciseConcept.nameOf(exercise))).toBe(lift)
    }
  })
})
