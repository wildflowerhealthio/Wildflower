import { Array as Arr, DateTime, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { WILDFLOWER_CANONICAL_BASE, WildflowerCodeSystem } from 'fhir-r4/data-types'
import { PlanDefinition } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type * as ExerciseSetObservation from '../exercise-set-observation/exercise-set-observation.ts'
import * as StrongLifts5x5 from '../plans/strong-lifts.ts'
import {
  exerciseRequestAt,
  instantArb,
  issuePathsOf,
  made,
  planArb,
  setAt,
  smallPlanArb,
  throughWire,
} from '../test-helpers.ts'
import * as Plan from './plan.ts'
import * as PlannedExercise from './planned-exercise.ts'
import * as ProgressionRule from './progression-rule.ts'
import * as Workout from './workout.ts'

// Making a plan decodes every planned exercise in every workout, so a
// property over plans runs fewer iterations than one over plain values.
const RUNS = numRunsFor({ base: 30 })

// Encode → JSON → decode of a whole PlanDefinition is the slow path, so the
// wire round-trip runs fewer iterations than the in-memory properties.
const WIRE_RUNS = numRunsFor({ base: 15 })

/** A plan as the wire carries it: a `PlanDefinition`, decoded and then narrowed. */
const WirePlan = Schema.compose(PlanDefinition.Schema, Plan.Schema)

describe('Plan', () => {
  it('should write an active PlanDefinition under the strength-training topic, with its canonical url', () => {
    const wire = Schema.encodeSync(WirePlan)(StrongLifts5x5.plan('plan-1'))
    expect(wire).toMatchObject({
      resourceType: 'PlanDefinition',
      id: 'plan-1',
      url: `${WILDFLOWER_CANONICAL_BASE}/PlanDefinition/plan-1`,
      status: 'active',
      title: 'StrongLifts 5×5',
      topic: [{ coding: [{ system: WildflowerCodeSystem.Feature, code: 'strength-training' }] }],
    })
    expect(wire.action?.map((workout) => workout.title)).toEqual(['A', 'B'])
  })

  it('should read back every plan it makes, through the wire', () => {
    fc.assert(
      fc.property(smallPlanArb, (plan) => {
        const read = throughWire(WirePlan, plan)
        expect(read.title).toBe(plan.title)
        expect(Plan.workoutsOf(read).map(Workout.labelOf)).toEqual(
          Plan.workoutsOf(plan).map(Workout.labelOf)
        )
        expect(Plan.plannedExercisesOf(read).map(summaryOf)).toEqual(
          Plan.plannedExercisesOf(plan).map(summaryOf)
        )
      }),
      { numRuns: WIRE_RUNS }
    )
  })

  it('should find each exercise it runs, once, and none it does not run', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const ids = Plan.plannedExercisesOf(plan).map(PlannedExercise.exerciseIdOf)
        expect(new Set(ids).size).toBe(ids.length)
        expect(ids.toSorted()).toEqual(
          Arr.dedupe(
            Plan.workoutsOf(plan).flatMap((workout) =>
              Workout.plannedExercisesOf(workout).map(PlannedExercise.exerciseIdOf)
            )
          ).toSorted()
        )
        for (const id of ids) {
          expect(
            Option.map(Plan.plannedExerciseOf(plan, id), PlannedExercise.exerciseIdOf)
          ).toEqual(Option.some(id))
        }
        expect(Plan.plannedExerciseOf(plan, 'not-planned-here-0')).toEqual(Option.none())
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a blank title and no workouts, naming each', () => {
    expect(issuePathsOf(Plan.make({ planDefinitionId: 'p', title: ' ', workouts: [] }))).toEqual([
      'title',
      'action.0',
    ])
  })

  it('should refuse two workouts with one label, naming the second', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const [first] = Plan.workoutsOf(plan)
        const workouts = [...Plan.workoutsOf(plan), first]
        expect(
          issuePathsOf(Plan.make({ planDefinitionId: 'plan-1', title: plan.title, workouts }))
        ).toEqual([`action.${workouts.length - 1}.title`])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse one exercise planned two ways, naming where it differs from its first', () => {
    fc.assert(
      fc.property(planArb, fc.integer({ min: 1, max: 5 }), (plan, moreSets) => {
        // Arrange
        const [firstWorkout] = Plan.workoutsOf(plan)
        const [planned] = Workout.plannedExercisesOf(firstWorkout)
        const replanned = made(
          PlannedExercise.make({
            exercise: PlannedExercise.exerciseOf(planned),
            sets: PlannedExercise.setsOf(planned) + moreSets,
            reps: PlannedExercise.repsOf(planned),
            progressionRule: PlannedExercise.progressionRuleOf(planned),
          })
        )
        const extra = made(Workout.make({ label: 'Extra', plannedExercises: [replanned] }))
        const workouts = [...Plan.workoutsOf(plan), extra]

        // Act / Assert
        expect(
          issuePathsOf(Plan.make({ planDefinitionId: 'plan-1', title: plan.title, workouts }))
        ).toEqual([`action.${workouts.length - 1}.action.0`])
      }),
      { numRuns: RUNS }
    )
  })
})

describe('nextWorkout', () => {
  it('should start StrongLifts at A, then alternate B, A, B', () => {
    const plan = StrongLifts5x5.plan('plan-1')
    expect(visitsOf(plan, 4).map(Workout.labelOf)).toEqual(['A', 'B', 'A', 'B'])
  })

  it('should visit every workout in cycle order, then wrap to the first', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const cycle = Plan.workoutsOf(plan).map(Workout.labelOf)
        const rounds = 2 * cycle.length + 1
        expect(visitsOf(plan, rounds).map(Workout.labelOf)).toEqual(
          Arr.makeBy(rounds, (index) => cycle[index % cycle.length])
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should follow the most recent set, whatever order the sets arrive in', () => {
    fc.assert(
      fc.property(
        planArb,
        fc.uniqueArray(fc.nat({ max: 1_000_000 }), { minLength: 1, maxLength: 6 }),
        fc.nat(),
        (plan, offsets, seed) => {
          // Arrange
          const workouts = Plan.workoutsOf(plan)
          const workoutIndexOf = (index: number): number => (seed + index) % workouts.length
          const sets = offsets.map((offset, index) =>
            setIn(
              Workout.labelOf(workouts[workoutIndexOf(index)] ?? Arr.headNonEmpty(workouts)),
              DateTime.unsafeMake(Date.UTC(2026, 0, 1) + offset * 1000)
            )
          )
          const latestWorkoutIndex = workoutIndexOf(offsets.indexOf(Math.max(...offsets)))

          // Act
          const next = Plan.nextWorkout(plan, Arr.reverse(sets))

          // Assert
          expect(next).toBe(workouts[(latestWorkoutIndex + 1) % workouts.length])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should start over at the first workout when the latest label is not in the plan', () => {
    fc.assert(
      fc.property(planArb, instantArb, (plan, start) => {
        expect(Plan.nextWorkout(plan, [setIn('not-a-workout', start)])).toBe(
          Arr.headNonEmpty(Plan.workoutsOf(plan))
        )
      }),
      { numRuns: RUNS }
    )
  })
})

// Helpers

/** What a planned exercise plans, comparable across a round trip. */
function summaryOf(planned: PlannedExercise.Type): readonly unknown[] {
  const rule = PlannedExercise.progressionRuleOf(planned)
  return [
    PlannedExercise.exerciseIdOf(planned),
    PlannedExercise.setsOf(planned),
    PlannedExercise.repsOf(planned),
    ProgressionRule.unitOf(rule),
    ProgressionRule.incrementOf(rule),
    ProgressionRule.failuresBeforeDeloadOf(rule),
    ProgressionRule.deloadFractionOf(rule),
    ProgressionRule.minimumLoadOf(rule),
    ProgressionRule.loadStepOf(rule),
  ]
}

/** A squat `ExerciseRequest` every generated set is logged against. */
const squatExerciseRequest = exerciseRequestAt(
  Workout.plannedExercisesOf(Arr.headNonEmpty(Plan.workoutsOf(StrongLifts5x5.plan('plan-1'))))[0],
  45
)

function setIn(workoutLabel: string, start: DateTime.Utc): ExerciseSetObservation.Type {
  return setAt({ exerciseRequest: squatExerciseRequest, workoutLabel, start, reps: 5 })
}

/** The workouts `nextWorkout` names over `count` visits, each logged a day after the last. */
function visitsOf(plan: Plan.Type, count: number): readonly Workout.Type[] {
  const sets: ExerciseSetObservation.Type[] = []
  return Arr.makeBy(count, (day) => {
    const workout = Plan.nextWorkout(plan, sets)
    sets.push(setIn(Workout.labelOf(workout), DateTime.unsafeMake(Date.UTC(2026, 0, day + 1))))
    return workout
  })
}
