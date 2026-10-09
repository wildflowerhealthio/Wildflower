import { Arbitrary, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { CodeableConcept } from 'fhir-r4/data-types'
import { PlanDefinitionAction } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as ExerciseParameter from '../exercise-parameter/exercise-parameter.ts'
import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import {
  exerciseConceptArb,
  issuePathsOf,
  made,
  trainingPlanDefinitionExerciseArb,
  progressionRuleArb,
  throughWire,
} from '../test-helpers.ts'
import * as TrainingPlanDefinition from './training-plan-definition.ts'

const RUNS = numRunsFor({ base: 100 })

// Encode → JSON → decode of an action and its extensions is the slow path, so
// the wire round-trip runs fewer iterations than the in-memory properties.
const WIRE_RUNS = numRunsFor({ base: 50 })

/** An exercise (definition) as the wire carries it: an action, decoded and then narrowed. */
const WireTrainingPlanDefinitionExercise = Schema.compose(
  PlanDefinitionAction.Schema,
  TrainingPlanDefinition.Exercise.Schema
)

describe('TrainingPlanDefinition.Exercise', () => {
  it('should read back what it defines, through the wire', () => {
    fc.assert(
      fc.property(
        exerciseConceptArb,
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 20 }),
        progressionRuleArb,
        (exerciseConcept, sets, reps, progressionRule) => {
          const trainingPlanDefinitionExercise = throughWire(
            WireTrainingPlanDefinitionExercise,
            made(
              TrainingPlanDefinition.Exercise.make({ exerciseConcept, sets, reps, progressionRule })
            )
          )
          expect(
            ExerciseConcept.idOf(
              TrainingPlanDefinition.Exercise.exerciseConceptOf(trainingPlanDefinitionExercise)
            )
          ).toBe(ExerciseConcept.idOf(exerciseConcept))
          expect(TrainingPlanDefinition.Exercise.exerciseIdOf(trainingPlanDefinitionExercise)).toBe(
            ExerciseConcept.idOf(exerciseConcept)
          )
          expect([
            TrainingPlanDefinition.Exercise.setsOf(trainingPlanDefinitionExercise),
            TrainingPlanDefinition.Exercise.repsOf(trainingPlanDefinitionExercise),
          ]).toEqual([sets, reps])
          expect(
            TrainingPlanDefinition.Exercise.progressionRuleOf(trainingPlanDefinitionExercise)
          ).toEqual(progressionRule)
        }
      ),
      { numRuns: WIRE_RUNS }
    )
  })

  it('should write the exercise concept, then the sets and reps exercise parameters, as the action code', () => {
    fc.assert(
      fc.property(trainingPlanDefinitionExerciseArb, (trainingPlanDefinitionExercise) => {
        const wire = Schema.encodeSync(WireTrainingPlanDefinitionExercise)(
          trainingPlanDefinitionExercise
        )
        expect(wire.code?.map((concept) => concept.coding?.[0]?.code)).toEqual([
          TrainingPlanDefinition.Exercise.exerciseIdOf(trainingPlanDefinitionExercise),
          ExerciseParameter.Code.Sets,
          ExerciseParameter.Code.Reps,
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse sets or reps that are not positive, naming each', () => {
    fc.assert(
      fc.property(
        exerciseConceptArb,
        progressionRuleArb,
        fc.boolean(),
        fc.boolean(),
        (exerciseConcept, progressionRule, badSets, badReps) => {
          fc.pre(badSets || badReps)
          const refused = TrainingPlanDefinition.Exercise.make({
            exerciseConcept,
            sets: badSets ? 0 : 5,
            reps: badReps ? -1 : 5,
            progressionRule,
          })
          expect(issuePathsOf(refused)).toEqual([
            ...(badSets ? ['code.1.extension.0.valueInteger'] : []),
            ...(badReps ? ['code.2.extension.0.valueInteger'] : []),
          ])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse a missing or repeated exercise concept, exercise parameter or rule, naming the list', () => {
    fc.assert(
      fc.property(
        trainingPlanDefinitionExerciseArb,
        fc.nat({ max: 2 }),
        fc.boolean(),
        (trainingPlanDefinitionExercise, index, doubled) => {
          // Arrange
          const code = doubled
            ? [
                ...trainingPlanDefinitionExercise.code,
                ...trainingPlanDefinitionExercise.code.slice(index, index + 1),
              ]
            : trainingPlanDefinitionExercise.code.filter((_, at) => at !== index)
          const decode = Schema.decodeEither(TrainingPlanDefinition.Exercise.Schema)

          // Act / Assert
          expect(issuePathsOf(decode({ ...trainingPlanDefinitionExercise, code }))).toEqual([
            'code',
          ])
          expect(
            issuePathsOf(decode({ ...trainingPlanDefinitionExercise, extension: [] }))
          ).toEqual(['extension'])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should ignore codes that are neither an exercise concept nor an exercise parameter', () => {
    fc.assert(
      fc.property(
        trainingPlanDefinitionExerciseArb,
        fc.array(Arbitrary.make(CodeableConcept.Schema), { maxLength: 3 }),
        (trainingPlanDefinitionExercise, foreign) => {
          fc.pre(foreign.every((concept) => concept.coding.length === 0))
          const padded = {
            ...trainingPlanDefinitionExercise,
            code: [...foreign, ...trainingPlanDefinitionExercise.code],
          }
          expect(
            Either.map(
              Schema.decodeEither(TrainingPlanDefinition.Exercise.Schema)(padded),
              TrainingPlanDefinition.Exercise.setsOf
            )
          ).toEqual(
            Either.right(TrainingPlanDefinition.Exercise.setsOf(trainingPlanDefinitionExercise))
          )
        }
      ),
      { numRuns: RUNS }
    )
  })
})
