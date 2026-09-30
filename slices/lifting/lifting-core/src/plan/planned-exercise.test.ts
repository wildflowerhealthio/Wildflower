import { Arbitrary, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { CodeableConcept } from 'fhir-r4/data-types'
import { PlanDefinitionAction } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import { LiftingMeasureCode } from '../lifting-measure/lifting-measure.ts'
import {
  exerciseArb,
  issuePathsOf,
  made,
  plannedArb,
  progressionRuleArb,
  throughWire,
} from '../test-helpers.ts'
import * as PlannedExercise from './planned-exercise.ts'

const RUNS = numRunsFor({ base: 100 })

// Encode → JSON → decode of an action and its extensions is the slow path, so
// the wire round-trip runs fewer iterations than the in-memory properties.
const WIRE_RUNS = numRunsFor({ base: 50 })

/** A planned exercise as the wire carries it: an action, decoded and then narrowed. */
const WirePlannedExercise = Schema.compose(PlanDefinitionAction.Schema, PlannedExercise.Schema)

describe('PlannedExercise', () => {
  it('should read back what it plans, through the wire', () => {
    fc.assert(
      fc.property(
        exerciseArb,
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 20 }),
        progressionRuleArb,
        (exercise, sets, reps, progressionRule) => {
          const planned = throughWire(
            WirePlannedExercise,
            made(PlannedExercise.make({ exercise, sets, reps, progressionRule }))
          )
          expect(ExerciseConcept.idOf(PlannedExercise.exerciseOf(planned))).toBe(
            ExerciseConcept.idOf(exercise)
          )
          expect(PlannedExercise.exerciseIdOf(planned)).toBe(ExerciseConcept.idOf(exercise))
          expect([PlannedExercise.setsOf(planned), PlannedExercise.repsOf(planned)]).toEqual([
            sets,
            reps,
          ])
          expect(PlannedExercise.progressionRuleOf(planned)).toEqual(progressionRule)
        }
      ),
      { numRuns: WIRE_RUNS }
    )
  })

  it('should write the exercise, then the sets and reps measures, as the action code', () => {
    fc.assert(
      fc.property(plannedArb, (planned) => {
        const wire = Schema.encodeSync(WirePlannedExercise)(planned)
        expect(wire.code?.map((concept) => concept.coding?.[0]?.code)).toEqual([
          PlannedExercise.exerciseIdOf(planned),
          LiftingMeasureCode.Sets,
          LiftingMeasureCode.Reps,
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse sets or reps that are not positive, naming each', () => {
    fc.assert(
      fc.property(
        exerciseArb,
        progressionRuleArb,
        fc.boolean(),
        fc.boolean(),
        (exercise, progressionRule, badSets, badReps) => {
          fc.pre(badSets || badReps)
          const refused = PlannedExercise.make({
            exercise,
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

  it('should refuse a missing or repeated exercise, measure or rule, naming the list', () => {
    fc.assert(
      fc.property(plannedArb, fc.nat({ max: 2 }), fc.boolean(), (planned, index, doubled) => {
        // Arrange
        const code = doubled
          ? [...planned.code, ...planned.code.slice(index, index + 1)]
          : planned.code.filter((_, at) => at !== index)
        const decode = Schema.decodeEither(PlannedExercise.Schema)

        // Act / Assert
        expect(issuePathsOf(decode({ ...planned, code }))).toEqual(['code'])
        expect(issuePathsOf(decode({ ...planned, extension: [] }))).toEqual(['extension'])
      }),
      { numRuns: RUNS }
    )
  })

  it('should ignore codes that are neither an exercise nor a lifting measure', () => {
    fc.assert(
      fc.property(
        plannedArb,
        fc.array(Arbitrary.make(CodeableConcept.Schema), { maxLength: 3 }),
        (planned, foreign) => {
          fc.pre(foreign.every((concept) => concept.coding.length === 0))
          const padded = { ...planned, code: [...foreign, ...planned.code] }
          expect(
            Either.map(Schema.decodeEither(PlannedExercise.Schema)(padded), PlannedExercise.setsOf)
          ).toEqual(Either.right(PlannedExercise.setsOf(planned)))
        }
      ),
      { numRuns: RUNS }
    )
  })
})
