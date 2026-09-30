import { Schema } from 'effect'
import * as fc from 'fast-check'
import { PlanDefinitionAction } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { issuePathsOf, made, plannedArb, throughWire, workoutLabelArb } from '../test-helpers.ts'
import * as PlannedExercise from './planned-exercise.ts'
import * as Workout from './workout.ts'

// Encode → JSON → decode of a workout's actions is the slow path, so it runs
// fewer iterations than a property over plain values would.
const RUNS = numRunsFor({ base: 25 })

/** A workout as the wire carries it: an action, decoded and then narrowed. */
const WireWorkout = Schema.compose(PlanDefinitionAction.Schema, Workout.Schema)

describe('Workout', () => {
  it('should read back its label and its planned exercises in order, through the wire', () => {
    fc.assert(
      fc.property(
        workoutLabelArb,
        fc.array(plannedArb, { minLength: 1, maxLength: 3 }),
        (label, plannedExercises) => {
          const workout = throughWire(WireWorkout, made(Workout.make({ label, plannedExercises })))
          expect(Workout.labelOf(workout)).toBe(label)
          expect(Workout.plannedExercisesOf(workout).map(PlannedExercise.exerciseIdOf)).toEqual(
            plannedExercises.map(PlannedExercise.exerciseIdOf)
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse a blank label and a workout that runs no exercises, naming each', () => {
    fc.assert(
      fc.property(fc.constantFrom('', ' ', '\t'), (label) => {
        expect(issuePathsOf(Workout.make({ label, plannedExercises: [] }))).toEqual([
          'title',
          'action.0',
        ])
      }),
      { numRuns: RUNS }
    )
  })
})
