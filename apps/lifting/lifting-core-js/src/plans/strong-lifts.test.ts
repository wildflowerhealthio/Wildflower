import { Either, Record } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as ExerciseRequest from '../exercise-request/exercise-request.ts'
import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import * as Load from '../load/load.ts'
import { AUTHORED_ON, SUBJECT } from '../test-helpers.ts'
import * as TrainingPlanDefinition from '../training-plan-definition/training-plan-definition.ts'
import * as StrongLifts5x5 from './strong-lifts.ts'

const LIFTS = Record.keys(StrongLifts5x5.EXERCISES)

describe('StrongLifts5x5', () => {
  it('should alternate A (squat, bench, row) with B (squat, press, deadlift)', () => {
    expect(
      TrainingPlanDefinition.daysOf(StrongLifts5x5.trainingPlanDefinition('plan-1')).map(
        (trainingPlanDefinitionDay) => [
          TrainingPlanDefinition.Day.labelOf(trainingPlanDefinitionDay),
          TrainingPlanDefinition.Day.exercisesOf(trainingPlanDefinitionDay).map(
            TrainingPlanDefinition.Exercise.exerciseIdOf
          ),
        ]
      )
    ).toEqual([
      ['A', ['squat', 'bench-press', 'barbell-row']],
      ['B', ['squat', 'overhead-press', 'deadlift']],
    ])
  })

  it('should run 5×5 at +5 lb for every lift but the deadlift, which is 1×5 at +10 lb', () => {
    expect(
      TrainingPlanDefinition.exercisesOf(StrongLifts5x5.trainingPlanDefinition('plan-1')).map(
        (trainingPlanDefinitionExercise) => [
          TrainingPlanDefinition.Exercise.exerciseIdOf(trainingPlanDefinitionExercise),
          TrainingPlanDefinition.Exercise.setsOf(trainingPlanDefinitionExercise),
          TrainingPlanDefinition.Exercise.repsOf(trainingPlanDefinitionExercise),
          TrainingPlanDefinition.ProgressionRule.incrementOf(
            TrainingPlanDefinition.Exercise.progressionRuleOf(trainingPlanDefinitionExercise)
          ),
          TrainingPlanDefinition.ProgressionRule.unitOf(
            TrainingPlanDefinition.Exercise.progressionRuleOf(trainingPlanDefinitionExercise)
          ),
        ]
      )
    ).toEqual([
      ['squat', 5, 5, 5, '[lb_av]'],
      ['bench-press', 5, 5, 5, '[lb_av]'],
      ['barbell-row', 5, 5, 5, '[lb_av]'],
      ['overhead-press', 5, 5, 5, '[lb_av]'],
      ['deadlift', 1, 5, 10, '[lb_av]'],
    ])
  })

  it('should deload every lift by 10% after three failures, in 5 lb steps, never below the bar', () => {
    for (const trainingPlanDefinitionExercise of TrainingPlanDefinition.exercisesOf(
      StrongLifts5x5.trainingPlanDefinition('plan-1')
    )) {
      const progressionRule = TrainingPlanDefinition.Exercise.progressionRuleOf(
        trainingPlanDefinitionExercise
      )
      expect([
        TrainingPlanDefinition.ProgressionRule.failuresBeforeDeloadOf(progressionRule),
        TrainingPlanDefinition.ProgressionRule.deloadFractionOf(progressionRule),
        TrainingPlanDefinition.ProgressionRule.minimumLoadOf(progressionRule),
        TrainingPlanDefinition.ProgressionRule.loadStepOf(progressionRule),
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
    const trainingPlanDefinition = StrongLifts5x5.trainingPlanDefinition('plan-1')
    for (const lift of LIFTS) {
      const made = ExerciseRequest.make({
        serviceRequestId: `sr-${lift}`,
        subject: SUBJECT,
        trainingPlanDefinition,
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
