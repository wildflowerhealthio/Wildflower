import { Schema } from 'effect'
import * as fc from 'fast-check'
import { PlanDefinitionAction } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  issuePathsOf,
  made,
  trainingPlanDefinitionExerciseArb,
  throughWire,
  dayLabelArb,
} from '../test-helpers.ts'
import * as TrainingPlanDefinition from './training-plan-definition.ts'

// Encode → JSON → decode of a day's actions is the slow path, so it runs
// fewer iterations than a property over plain values would.
const RUNS = numRunsFor({ base: 25 })

/** A day as the wire carries it: an action, decoded and then narrowed. */
const WireTrainingPlanDefinitionDay = Schema.compose(
  PlanDefinitionAction.Schema,
  TrainingPlanDefinition.Day.Schema
)

describe('TrainingPlanDefinition.Day', () => {
  it('should read back its label and its exercises (definitions) in order, through the wire', () => {
    fc.assert(
      fc.property(
        dayLabelArb,
        fc.array(trainingPlanDefinitionExerciseArb, { minLength: 1, maxLength: 3 }),
        (label, trainingPlanDefinitionExercises) => {
          const trainingPlanDefinitionDay = throughWire(
            WireTrainingPlanDefinitionDay,
            made(TrainingPlanDefinition.Day.make({ label, trainingPlanDefinitionExercises }))
          )
          expect(TrainingPlanDefinition.Day.labelOf(trainingPlanDefinitionDay)).toBe(label)
          expect(
            TrainingPlanDefinition.Day.exercisesOf(trainingPlanDefinitionDay).map(
              TrainingPlanDefinition.Exercise.exerciseIdOf
            )
          ).toEqual(
            trainingPlanDefinitionExercises.map(TrainingPlanDefinition.Exercise.exerciseIdOf)
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse an empty or untrimmed label and a day that runs no exercises, naming each', () => {
    fc.assert(
      fc.property(fc.constantFrom('', ' ', '\t', ' A', 'A\n'), (label) => {
        expect(
          issuePathsOf(
            TrainingPlanDefinition.Day.make({ label, trainingPlanDefinitionExercises: [] })
          )
        ).toEqual(['title', 'action.0'])
      }),
      { numRuns: RUNS }
    )
  })
})
