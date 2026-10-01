import { Array as Arr, DateTime, Either, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { IdentifierAndReference } from 'fhir-r4/data-types'
import { numRunsFor } from 'kitchen-sink/test'
import { assert, describe, expect, it } from 'vite-plus/test'

import * as ExerciseSetObservation from '../exercise-set-observation/exercise-set-observation.ts'
import * as Load from '../load/load.ts'
import * as StrongLifts5x5 from '../plans/strong-lifts.ts'
import {
  AUTHORED_ON,
  deloadCaseArb,
  fewFailuresCaseArb,
  incrementCaseArb,
  made,
  type ProgressionCase,
  progressionCaseArb,
  performedWorkoutAt,
  someOrFail,
  SUBJECT,
} from '../test-helpers.ts'
import * as TrainingPlanDefinition from '../training-plan-definition/training-plan-definition.ts'
import * as WorkoutProcedure from '../workout-procedure/workout-procedure.ts'
import * as ExerciseRequest from './exercise-request.ts'

// Each case makes its `ExerciseRequest`s, workouts and sets through their schemas, so a property
// over them runs fewer iterations than one over plain values.
const RUNS = numRunsFor({ base: 60 })

const STEP_AUTHORED_ON = DateTime.unsafeMake('2026-01-07T18:00:00Z')

const trainingPlanDefinition = StrongLifts5x5.trainingPlanDefinition('plan-1')

/** The StrongLifts barbell rule: +5 lb, three failures deload 10% in 5 lb steps, never below 45 lb. */
const barbell = TrainingPlanDefinition.Exercise.progressionRuleOf(
  someOrFail(TrainingPlanDefinition.exerciseOf({ trainingPlanDefinition, exerciseId: 'squat' }))
)

/** The StrongLifts squat at `value` lb, stored as `sr-2`. */
const squatAt = (value: number): ExerciseRequest.Type =>
  made(
    ExerciseRequest.make({
      serviceRequestId: 'sr-2',
      subject: SUBJECT,
      trainingPlanDefinition,
      exerciseId: 'squat',
      load: made(Load.make({ value, unit: '[lb_av]' })),
      authoredOn: AUTHORED_ON,
    })
  )

/** What the lifter performed: the workouts and the sets in them. */
interface Performed {
  readonly workoutProcedures: readonly WorkoutProcedure.Type[]
  readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
}

/** One progression step over what was performed, issuing `sr-3`. */
const step = (
  spec: {
    readonly exerciseRequest: ExerciseRequest.Type
    readonly progressionRule: TrainingPlanDefinition.ProgressionRule.Type
  } & Performed
): Either.Either<ExerciseRequest.Progress, unknown> =>
  ExerciseRequest.progress({
    ...spec,
    nextServiceRequestId: 'sr-3',
    authoredOn: STEP_AUTHORED_ON,
  })

/** The step a generated case calls for, which must succeed. */
const stepOf = (progressionCase: ProgressionCase): ExerciseRequest.Progress =>
  made(
    step({
      ...progressionCase,
      progressionRule: TrainingPlanDefinition.Exercise.progressionRuleOf(
        progressionCase.trainingPlanDefinitionExercise
      ),
    })
  )

/** Nothing performed yet. */
const NOTHING: Performed = { workoutProcedures: [], exerciseSetObservations: [] }

/** One completed workout per entry of `repsPerWorkout`, a day apart, each with its sets against `exerciseRequest`. */
const history = ({
  exerciseRequest,
  repsPerWorkout,
}: {
  readonly exerciseRequest: ExerciseRequest.Type
  readonly repsPerWorkout: readonly (readonly number[])[]
}): Performed => {
  const performed = repsPerWorkout.map((reps, index) =>
    performedWorkoutAt({ exerciseRequest, index, reps })
  )
  return {
    workoutProcedures: performed.map(({ workoutProcedure }) => workoutProcedure),
    exerciseSetObservations: performed.flatMap(
      ({ exerciseSetObservations }) => exerciseSetObservations
    ),
  }
}

/** The load value of an issued `ExerciseRequest`. */
const loadValueOf = (exerciseRequest: ExerciseRequest.Type): number =>
  Load.valueOf(ExerciseRequest.loadOf(exerciseRequest))

describe('ExerciseRequest.progress', () => {
  it('should hold an `ExerciseRequest` with no workout yet, writing nothing', () => {
    const current = squatAt(135)
    expect(step({ exerciseRequest: current, progressionRule: barbell, ...NOTHING })).toEqual(
      Either.right({ decision: 'hold', current, next: Option.none() })
    )
  })

  it('should complete a met 135 lb squat and issue 140 lb in its place', () => {
    // Arrange
    const current = squatAt(135)

    // Act
    const progress = made(
      step({
        exerciseRequest: current,
        progressionRule: barbell,
        ...history({ exerciseRequest: current, repsPerWorkout: [[5, 5, 5, 5, 5]] }),
      })
    )

    // Assert
    const next = someOrFail(progress.next)
    expect(progress.decision).toBe('increment')
    expect(progress.current).toEqual({ ...current, status: 'completed' })
    expect(loadValueOf(next)).toBe(140)
    expect([next.id, next.status, next.authoredOn]).toEqual([
      'sr-3',
      'active',
      DateTime.formatIso(STEP_AUTHORED_ON),
    ])
    expect(next.replaces).toEqual([
      IdentifierAndReference.referenceTo({ resourceType: 'ServiceRequest', id: 'sr-2' }),
    ])
  })

  it('should hold after one and two failed workouts, and deload 10% after the third', () => {
    // Arrange
    const current = squatAt(150)
    const failed = [5, 5, 5, 4, 3]

    // Act
    const afterEach = [1, 2, 3].map((workoutCount) =>
      made(
        step({
          exerciseRequest: current,
          progressionRule: barbell,
          ...history({
            exerciseRequest: current,
            repsPerWorkout: Array.from({ length: workoutCount }, () => failed),
          }),
        })
      )
    )

    // Assert
    expect(afterEach.map((progress) => progress.decision)).toEqual(['hold', 'hold', 'deload'])
    // 150 × 0.9 is 134.99999… in floating point; it still lands on 135.
    expect(Option.map(afterEach[2]?.next ?? Option.none(), loadValueOf)).toEqual(Option.some(135))
    expect(afterEach[2]?.current.status).toBe('revoked')
  })

  it('should not deload below the empty bar', () => {
    // 50 × 0.9 = 45; 45 × 0.9 = 40.5 would round to 40, under the 45 lb floor.
    const at50 = squatAt(50)
    const at45 = squatAt(45)
    const failuresAt = (current: ExerciseRequest.Type): Performed =>
      history({
        exerciseRequest: current,
        repsPerWorkout: [
          [4, 4, 4, 4, 4],
          [4, 4, 4, 4, 4],
          [4, 4, 4, 4, 4],
        ],
      })
    const from50 = made(
      step({ exerciseRequest: at50, progressionRule: barbell, ...failuresAt(at50) })
    )
    expect(from50.decision).toBe('deload')
    expect(loadValueOf(someOrFail(from50.next))).toBe(45)
    expect(
      made(step({ exerciseRequest: at45, progressionRule: barbell, ...failuresAt(at45) })).decision
    ).toBe('hold')
  })

  it('should refuse a load in a unit the rule does not move', () => {
    const kilograms = made(
      TrainingPlanDefinition.ProgressionRule.make({
        unit: 'kg',
        increment: 2.5,
        failuresBeforeDeload: 3,
        deloadFraction: 0.1,
        minimumLoad: 20,
        loadStep: 2.5,
      })
    )
    const refused = step({
      exerciseRequest: squatAt(135),
      progressionRule: kilograms,
      ...NOTHING,
    })
    expect(
      Either.match(refused, {
        onLeft: (error) => (error instanceof Error ? error.message : ''),
        onRight: () => '',
      })
    ).toContain('expected a load in kg')
  })

  it('should make the decision each class of history calls for', () => {
    fc.assert(
      fc.property(progressionCaseArb, (progressionCase) => {
        // Act
        const { decision, current, next } = stepOf(progressionCase)

        // Assert
        const { expected, exerciseRequest, trainingPlanDefinitionExercise } = progressionCase
        expect(decision).toBe(expected)
        if (expected === 'increment') {
          expect(current.status).toBe('completed')
          expect(loadValueOf(someOrFail(next))).toBe(
            loadValueOf(exerciseRequest) +
              TrainingPlanDefinition.ProgressionRule.incrementOf(
                TrainingPlanDefinition.Exercise.progressionRuleOf(trainingPlanDefinitionExercise)
              )
          )
        } else if (expected === 'deload') {
          expect(current.status).toBe('revoked')
          expectDeloadedWithinRule({
            progressionRule: TrainingPlanDefinition.Exercise.progressionRuleOf(
              trainingPlanDefinitionExercise
            ),
            load: loadValueOf(exerciseRequest),
            deloaded: loadValueOf(someOrFail(next)),
          })
        } else if (expected === 'hold') {
          expect(current).toBe(exerciseRequest)
          expect(next).toEqual(Option.none())
        } else {
          assert.fail(`no expectation for ${String(expected satisfies never)}`)
        }
      }),
      { numRuns: RUNS }
    )
  })

  it('should never let a deload land below the floor or above the load', () => {
    fc.assert(
      fc.property(deloadCaseArb, (progressionCase) => {
        const deloaded = loadValueOf(someOrFail(stepOf(progressionCase).next))
        expect(deloaded).toBeGreaterThanOrEqual(
          TrainingPlanDefinition.ProgressionRule.minimumLoadOf(
            TrainingPlanDefinition.Exercise.progressionRuleOf(
              progressionCase.trainingPlanDefinitionExercise
            )
          )
        )
        expect(deloaded).toBeLessThan(loadValueOf(progressionCase.exerciseRequest))
      }),
      { numRuns: RUNS }
    )
  })

  it('should change nothing but the load, the id, the lineage and the date in what it issues', () => {
    fc.assert(
      fc.property(progressionCaseArb, (progressionCase) => {
        const current = progressionCase.exerciseRequest
        Option.map(stepOf(progressionCase).next, (issued) => {
          expect(ExerciseRequest.exerciseOf(issued)).toEqual(ExerciseRequest.exerciseOf(current))
          expect(Load.unitOf(ExerciseRequest.loadOf(issued))).toBe(
            Load.unitOf(ExerciseRequest.loadOf(current))
          )
          expect([ExerciseRequest.setsOf(issued), ExerciseRequest.repsOf(issued)]).toEqual([
            ExerciseRequest.setsOf(current),
            ExerciseRequest.repsOf(current),
          ])
          expect(issued.subject).toEqual(current.subject)
          expect(ExerciseRequest.trainingPlanDefinitionUrlOf(issued)).toBe(
            ExerciseRequest.trainingPlanDefinitionUrlOf(current)
          )
        })
      }),
      { numRuns: RUNS }
    )
  })

  it('should hold what it issues, since nothing has been logged against it', () => {
    fc.assert(
      fc.property(progressionCaseArb, (progressionCase) => {
        Option.map(stepOf(progressionCase).next, (issued) => {
          expect(
            Either.map(
              step({
                exerciseRequest: issued,
                progressionRule: TrainingPlanDefinition.Exercise.progressionRuleOf(
                  progressionCase.trainingPlanDefinitionExercise
                ),
                ...NOTHING,
              }),
              (progress) => progress.decision
            )
          ).toEqual(Either.right('hold'))
        })
      }),
      { numRuns: RUNS }
    )
  })

  it('should decide the same whatever order the workouts and sets arrive in', () => {
    fc.assert(
      fc.property(
        progressionCaseArb.chain((progressionCase) =>
          fc
            .tuple(
              fc.shuffledSubarray([...progressionCase.workoutProcedures], {
                minLength: progressionCase.workoutProcedures.length,
              }),
              fc.shuffledSubarray([...progressionCase.exerciseSetObservations], {
                minLength: progressionCase.exerciseSetObservations.length,
              })
            )
            .map(([workoutProcedures, exerciseSetObservations]) => ({
              progressionCase,
              shuffled: { ...progressionCase, workoutProcedures, exerciseSetObservations },
            }))
        ),
        ({ progressionCase, shuffled }) => {
          expect(stepOf(shuffled)).toEqual(stepOf(progressionCase))
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should never judge a workout still in progress', () => {
    fc.assert(
      fc.property(progressionCaseArb, (progressionCase) => {
        // Arrange: the latest workout reopened, as if the lifter were still in it.
        const latest = Arr.last(progressionCase.workoutProcedures)
        fc.pre(Option.isSome(latest))
        const reopened = Option.getOrThrow(latest)
        const inProgress = made(
          Schema.decodeEither(WorkoutProcedure.Schema)({
            ...reopened,
            status: 'in-progress',
            performedPeriod: { ...reopened.performedPeriod, end: null },
          })
        )
        const earlier = progressionCase.workoutProcedures.slice(0, -1)

        // Act / Assert: the step sees only the workouts before it.
        expect(stepOf({ ...progressionCase, workoutProcedures: [...earlier, inProgress] })).toEqual(
          stepOf({
            ...progressionCase,
            workoutProcedures: earlier,
            exerciseSetObservations: progressionCase.exerciseSetObservations.filter(
              (exerciseSetObservation) =>
                ExerciseSetObservation.procedureIdOf(exerciseSetObservation) !== reopened.id
            ),
          })
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should issue an `ExerciseRequest` its own schema reads back', () => {
    fc.assert(
      fc.property(incrementCaseArb, (progressionCase) => {
        const issued = someOrFail(stepOf(progressionCase).next)
        expect(Either.isRight(Schema.decodeEither(ExerciseRequest.Schema)(issued))).toBe(true)
      }),
      { numRuns: RUNS }
    )
  })
})

describe('ExerciseRequest.consecutiveFailures', () => {
  it('should count exactly the failed workouts since the last met one', () => {
    fc.assert(
      fc.property(
        fewFailuresCaseArb,
        ({ exerciseRequest, workoutProcedures, exerciseSetObservations, trailingFailures }) => {
          expect(
            ExerciseRequest.consecutiveFailures(
              exerciseRequest,
              ExerciseRequest.attemptsAt(exerciseRequest, {
                workoutProcedures,
                exerciseSetObservations,
              })
            )
          ).toBe(trailingFailures)
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should be zero after a met workout', () => {
    fc.assert(
      fc.property(
        incrementCaseArb,
        ({ exerciseRequest, workoutProcedures, exerciseSetObservations }) => {
          expect(
            ExerciseRequest.consecutiveFailures(
              exerciseRequest,
              ExerciseRequest.attemptsAt(exerciseRequest, {
                workoutProcedures,
                exerciseSetObservations,
              })
            )
          ).toBe(0)
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should reach the deload threshold on a deload-class history', () => {
    fc.assert(
      fc.property(
        deloadCaseArb,
        ({
          trainingPlanDefinitionExercise,
          exerciseRequest,
          workoutProcedures,
          exerciseSetObservations,
        }) => {
          expect(
            ExerciseRequest.consecutiveFailures(
              exerciseRequest,
              ExerciseRequest.attemptsAt(exerciseRequest, {
                workoutProcedures,
                exerciseSetObservations,
              })
            )
          ).toBeGreaterThanOrEqual(
            TrainingPlanDefinition.ProgressionRule.failuresBeforeDeloadOf(
              TrainingPlanDefinition.Exercise.progressionRuleOf(trainingPlanDefinitionExercise)
            )
          )
        }
      ),
      { numRuns: RUNS }
    )
  })
})

// Helpers

/**
 * A deloaded load obeys the rule's promises, without recomputing it: below the
 * old load, at or above the floor, a step multiple unless it is the floor, and
 * no more than one step under the fraction.
 */
function expectDeloadedWithinRule({
  progressionRule,
  load,
  deloaded,
}: {
  readonly progressionRule: TrainingPlanDefinition.ProgressionRule.Type
  readonly load: number
  readonly deloaded: number
}): void {
  const deloadFraction = TrainingPlanDefinition.ProgressionRule.deloadFractionOf(progressionRule)
  const loadStep = TrainingPlanDefinition.ProgressionRule.loadStepOf(progressionRule)
  const minimumLoad = TrainingPlanDefinition.ProgressionRule.minimumLoadOf(progressionRule)
  expect(deloaded).toBeLessThan(load)
  expect(deloaded).toBeGreaterThanOrEqual(minimumLoad)
  if (deloaded !== minimumLoad) {
    const steps = deloaded / loadStep
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6)
    expect(deloaded).toBeLessThanOrEqual(load * (1 - deloadFraction) + 1e-6)
    expect(deloaded).toBeGreaterThan(load * (1 - deloadFraction) - loadStep - 1e-6)
  }
}
