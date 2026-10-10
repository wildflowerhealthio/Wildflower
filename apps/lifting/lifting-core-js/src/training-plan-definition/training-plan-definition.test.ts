import {
  WILDFLOWER_CANONICAL_BASE,
  WildflowerCodeSystem,
} from '@wildflowerhealthio/fhir-r4/data-types'
import { PlanDefinition } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Array as Arr, DateTime, Either, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as StrongLifts5x5 from '../plans/strong-lifts.ts'
import {
  exerciseRequestAt,
  instantArb,
  issuePathsOf,
  made,
  trainingPlanDefinitionArb,
  SUBJECT,
  smallTrainingPlanDefinitionArb,
  throughWire,
} from '../test-helpers.ts'
import * as WorkoutProcedure from '../workout-procedure/workout-procedure.ts'
import * as TrainingPlanDefinition from './training-plan-definition.ts'

// Making a training plan definition decodes every exercise (definition) on
// every day, so a property over them runs fewer iterations than one over
// plain values.
const RUNS = numRunsFor({ base: 30 })

// Encode → JSON → decode of a whole PlanDefinition is the slow path, so the
// wire round-trip runs fewer iterations than the in-memory properties.
const WIRE_RUNS = numRunsFor({ base: 15 })

/** A training plan definition as the wire carries it: a `PlanDefinition`, decoded and then narrowed. */
const WireTrainingPlanDefinition = Schema.compose(
  PlanDefinition.Schema,
  TrainingPlanDefinition.Schema
)

describe('TrainingPlanDefinition', () => {
  it('should write an active PlanDefinition under the strength-training topic, with its canonical url', () => {
    const wire = Schema.encodeSync(WireTrainingPlanDefinition)(
      StrongLifts5x5.trainingPlanDefinition('plan-1')
    )
    expect(wire).toMatchObject({
      resourceType: 'PlanDefinition',
      id: 'plan-1',
      url: `${WILDFLOWER_CANONICAL_BASE}/PlanDefinition/plan-1`,
      status: 'active',
      title: 'StrongLifts 5×5',
      topic: [{ coding: [{ system: WildflowerCodeSystem.Feature, code: 'strength-training' }] }],
    })
    expect(
      wire.action?.map((trainingPlanDefinitionDay) => trainingPlanDefinitionDay.title)
    ).toEqual(['A', 'B'])
  })

  it('should read back every training plan definition it makes, through the wire', () => {
    fc.assert(
      fc.property(smallTrainingPlanDefinitionArb, (trainingPlanDefinition) => {
        const read = throughWire(WireTrainingPlanDefinition, trainingPlanDefinition)
        expect(read.title).toBe(trainingPlanDefinition.title)
        expect(TrainingPlanDefinition.daysOf(read).map(TrainingPlanDefinition.Day.labelOf)).toEqual(
          TrainingPlanDefinition.daysOf(trainingPlanDefinition).map(
            TrainingPlanDefinition.Day.labelOf
          )
        )
        expect(TrainingPlanDefinition.exercisesOf(read).map(summaryOf)).toEqual(
          TrainingPlanDefinition.exercisesOf(trainingPlanDefinition).map(summaryOf)
        )
      }),
      { numRuns: WIRE_RUNS }
    )
  })

  it('should find each exercise it runs, once, and none it does not run', () => {
    fc.assert(
      fc.property(trainingPlanDefinitionArb, (trainingPlanDefinition) => {
        const ids = TrainingPlanDefinition.exercisesOf(trainingPlanDefinition).map(
          TrainingPlanDefinition.Exercise.exerciseIdOf
        )
        expect(new Set(ids).size).toBe(ids.length)
        expect(ids.toSorted()).toEqual(
          Arr.dedupe(
            TrainingPlanDefinition.daysOf(trainingPlanDefinition).flatMap(
              (trainingPlanDefinitionDay) =>
                TrainingPlanDefinition.Day.exercisesOf(trainingPlanDefinitionDay).map(
                  TrainingPlanDefinition.Exercise.exerciseIdOf
                )
            )
          ).toSorted()
        )
        for (const id of ids) {
          expect(
            Option.map(
              TrainingPlanDefinition.exerciseOf({ trainingPlanDefinition, exerciseId: id }),
              TrainingPlanDefinition.Exercise.exerciseIdOf
            )
          ).toEqual(Option.some(id))
        }
        expect(
          TrainingPlanDefinition.exerciseOf({
            trainingPlanDefinition,
            exerciseId: 'not-an-exercise-here-0',
          })
        ).toEqual(Option.none())
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse an empty or untrimmed title and no days, naming each', () => {
    fc.assert(
      fc.property(fc.constantFrom('', ' ', ' Plan', 'Plan\n'), (title) => {
        expect(
          issuePathsOf(
            TrainingPlanDefinition.make({
              planDefinitionId: 'p',
              title,
              trainingPlanDefinitionDays: [],
            })
          )
        ).toEqual(['title', 'action.0'])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse two days with one label, naming the second', () => {
    fc.assert(
      fc.property(trainingPlanDefinitionArb, (trainingPlanDefinition) => {
        const [firstTrainingPlanDefinitionDay] =
          TrainingPlanDefinition.daysOf(trainingPlanDefinition)
        const trainingPlanDefinitionDays = [
          ...TrainingPlanDefinition.daysOf(trainingPlanDefinition),
          firstTrainingPlanDefinitionDay,
        ]
        expect(
          issuePathsOf(
            TrainingPlanDefinition.make({
              planDefinitionId: 'plan-1',
              title: trainingPlanDefinition.title,
              trainingPlanDefinitionDays,
            })
          )
        ).toEqual([`action.${trainingPlanDefinitionDays.length - 1}.title`])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse one exercise defined two ways, naming where it differs from its first', () => {
    fc.assert(
      fc.property(
        trainingPlanDefinitionArb,
        fc.integer({ min: 1, max: 5 }),
        (trainingPlanDefinition, moreSets) => {
          // Arrange
          const [firstTrainingPlanDefinitionDay] =
            TrainingPlanDefinition.daysOf(trainingPlanDefinition)
          const [trainingPlanDefinitionExercise] = TrainingPlanDefinition.Day.exercisesOf(
            firstTrainingPlanDefinitionDay
          )
          const redefined = made(
            TrainingPlanDefinition.Exercise.make({
              exerciseConcept: TrainingPlanDefinition.Exercise.exerciseConceptOf(
                trainingPlanDefinitionExercise
              ),
              sets:
                TrainingPlanDefinition.Exercise.setsOf(trainingPlanDefinitionExercise) + moreSets,
              reps: TrainingPlanDefinition.Exercise.repsOf(trainingPlanDefinitionExercise),
              progressionRule: TrainingPlanDefinition.Exercise.progressionRuleOf(
                trainingPlanDefinitionExercise
              ),
            })
          )
          const extraTrainingPlanDefinitionDay = made(
            TrainingPlanDefinition.Day.make({
              label: 'Extra',
              trainingPlanDefinitionExercises: [redefined],
            })
          )
          const trainingPlanDefinitionDays = [
            ...TrainingPlanDefinition.daysOf(trainingPlanDefinition),
            extraTrainingPlanDefinitionDay,
          ]

          // Act / Assert
          expect(
            issuePathsOf(
              TrainingPlanDefinition.make({
                planDefinitionId: 'plan-1',
                title: trainingPlanDefinition.title,
                trainingPlanDefinitionDays,
              })
            )
          ).toEqual([`action.${trainingPlanDefinitionDays.length - 1}.action.0`])
        }
      ),
      { numRuns: RUNS }
    )
  })
})

describe('nextDay', () => {
  it('should start StrongLifts at A, then alternate B, A, B', () => {
    const trainingPlanDefinition = StrongLifts5x5.trainingPlanDefinition('plan-1')
    expect(visitsOf(trainingPlanDefinition, 4).map(TrainingPlanDefinition.Day.labelOf)).toEqual([
      'A',
      'B',
      'A',
      'B',
    ])
  })

  it('should visit every day in cycle order, then wrap to the first', () => {
    fc.assert(
      fc.property(trainingPlanDefinitionArb, (trainingPlanDefinition) => {
        const cycle = TrainingPlanDefinition.daysOf(trainingPlanDefinition).map(
          TrainingPlanDefinition.Day.labelOf
        )
        const rounds = 2 * cycle.length + 1
        expect(
          visitsOf(trainingPlanDefinition, rounds).map(TrainingPlanDefinition.Day.labelOf)
        ).toEqual(Arr.makeBy(rounds, (index) => cycle[index % cycle.length]))
      }),
      { numRuns: RUNS }
    )
  })

  it('should follow the most recently started completed workout, whatever order they arrive in', () => {
    fc.assert(
      fc.property(
        trainingPlanDefinitionArb,
        fc.uniqueArray(fc.nat({ max: 1_000_000 }), { minLength: 1, maxLength: 6 }),
        fc.nat(),
        (trainingPlanDefinition, offsets, seed) => {
          // Arrange
          const trainingPlanDefinitionDays = TrainingPlanDefinition.daysOf(trainingPlanDefinition)
          const dayIndexOf = (index: number): number =>
            (seed + index) % trainingPlanDefinitionDays.length
          const performed = offsets.map((offset, index) =>
            completedIn({
              trainingPlanDefinition,
              trainingPlanDefinitionDay:
                trainingPlanDefinitionDays[dayIndexOf(index)] ??
                Arr.headNonEmpty(trainingPlanDefinitionDays),
              start: DateTime.unsafeMake(Date.UTC(2026, 0, 1) + offset * 1000),
            })
          )
          const latestDayIndex = dayIndexOf(offsets.indexOf(Math.max(...offsets)))

          // Act
          const next = TrainingPlanDefinition.nextDay({
            trainingPlanDefinition,
            latestCompletedWorkoutProcedure: WorkoutProcedure.latestCompleted(
              Arr.reverse(performed)
            ),
          })

          // Assert
          expect(next).toBe(
            trainingPlanDefinitionDays[(latestDayIndex + 1) % trainingPlanDefinitionDays.length]
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should start over at the first day when the latest workout performed a day not in the training plan definition', () => {
    fc.assert(
      fc.property(trainingPlanDefinitionArb, instantArb, (trainingPlanDefinition, start) => {
        const [trainingPlanDefinitionExercise] = TrainingPlanDefinition.Day.exercisesOf(
          Arr.headNonEmpty(TrainingPlanDefinition.daysOf(trainingPlanDefinition))
        )
        // The training plan definition as it was before its days were
        // replaced: same url, other labels.
        const replacedTrainingPlanDefinitionDay = made(
          TrainingPlanDefinition.Day.make({
            label: 'not-a-day',
            trainingPlanDefinitionExercises: [trainingPlanDefinitionExercise],
          })
        )
        const before = made(
          TrainingPlanDefinition.make({
            planDefinitionId: 'plan-1',
            title: trainingPlanDefinition.title,
            trainingPlanDefinitionDays: [replacedTrainingPlanDefinitionDay],
          })
        )
        expect(
          TrainingPlanDefinition.nextDay({
            trainingPlanDefinition,
            latestCompletedWorkoutProcedure: Option.some(
              completedIn({
                trainingPlanDefinition: before,
                trainingPlanDefinitionDay: replacedTrainingPlanDefinitionDay,
                start,
              })
            ),
          })
        ).toBe(Arr.headNonEmpty(TrainingPlanDefinition.daysOf(trainingPlanDefinition)))
      }),
      { numRuns: RUNS }
    )
  })
})

// Helpers

/** What an exercise (definition) defines, comparable across a round trip. */
function summaryOf(
  trainingPlanDefinitionExercise: TrainingPlanDefinition.Exercise.Type
): readonly unknown[] {
  const progressionRule = TrainingPlanDefinition.Exercise.progressionRuleOf(
    trainingPlanDefinitionExercise
  )
  return [
    TrainingPlanDefinition.Exercise.exerciseIdOf(trainingPlanDefinitionExercise),
    TrainingPlanDefinition.Exercise.setsOf(trainingPlanDefinitionExercise),
    TrainingPlanDefinition.Exercise.repsOf(trainingPlanDefinitionExercise),
    TrainingPlanDefinition.ProgressionRule.unitOf(progressionRule),
    TrainingPlanDefinition.ProgressionRule.incrementOf(progressionRule),
    TrainingPlanDefinition.ProgressionRule.failuresBeforeDeloadOf(progressionRule),
    TrainingPlanDefinition.ProgressionRule.deloadFractionOf(progressionRule),
    TrainingPlanDefinition.ProgressionRule.minimumLoadOf(progressionRule),
    TrainingPlanDefinition.ProgressionRule.loadStepOf(progressionRule),
  ]
}

/** A squat `ExerciseRequest` every generated workout carries out. */
const squatExerciseRequest = exerciseRequestAt(
  TrainingPlanDefinition.Day.exercisesOf(
    Arr.headNonEmpty(TrainingPlanDefinition.daysOf(StrongLifts5x5.trainingPlanDefinition('plan-1')))
  )[0],
  45
)

/**
 * A workout performing `trainingPlanDefinitionDay` of `trainingPlanDefinition`,
 * started at `start` and completed an hour later.
 */
function completedIn({
  trainingPlanDefinition,
  trainingPlanDefinitionDay,
  start,
}: {
  readonly trainingPlanDefinition: TrainingPlanDefinition.Type
  readonly trainingPlanDefinitionDay: TrainingPlanDefinition.Day.Type
  readonly start: DateTime.Utc
}): WorkoutProcedure.Type {
  return made(
    Either.flatMap(
      WorkoutProcedure.make({
        procedureId: `workout-${DateTime.toEpochMillis(start)}`,
        subject: SUBJECT,
        trainingPlanDefinition,
        trainingPlanDefinitionDay,
        exerciseRequests: [squatExerciseRequest],
        start,
      }),
      (started) => WorkoutProcedure.complete(started, DateTime.addDuration(start, '1 hour'))
    )
  )
}

/** The days `nextDay` names over `count` visits, each performed a day after the last. */
function visitsOf(
  trainingPlanDefinition: TrainingPlanDefinition.Type,
  count: number
): readonly TrainingPlanDefinition.Day.Type[] {
  const performed: WorkoutProcedure.Type[] = []
  return Arr.makeBy(count, (visit) => {
    const trainingPlanDefinitionDay = TrainingPlanDefinition.nextDay({
      trainingPlanDefinition,
      latestCompletedWorkoutProcedure: WorkoutProcedure.latestCompleted(performed),
    })
    performed.push(
      completedIn({
        trainingPlanDefinition,
        trainingPlanDefinitionDay,
        start: DateTime.unsafeMake(Date.UTC(2026, 0, visit + 1)),
      })
    )
    return trainingPlanDefinitionDay
  })
}
