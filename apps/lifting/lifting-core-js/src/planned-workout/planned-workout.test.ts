import { Array as Arr, DateTime, Either, Option, Record as EffectRecord } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as ExerciseRequest from '../exercise-request/exercise-request.ts'
import * as ExerciseSetObservation from '../exercise-set-observation/exercise-set-observation.ts'
import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import * as Load from '../load/load.ts'
import * as StrongLifts5x5 from '../plans/strong-lifts.ts'
import {
  AUTHORED_ON,
  instantArb,
  made,
  someOrFail,
  startingLoadsAtFloorOf,
  SUBJECT,
  trainingPlanDefinitionArb,
} from '../test-helpers.ts'
import * as TrainingPlanDefinition from '../training-plan-definition/training-plan-definition.ts'
import * as WorkoutProcedure from '../workout-procedure/workout-procedure.ts'
import * as PlannedWorkout from './planned-workout.ts'

// Each case makes a training plan definition, an `ExerciseRequest` per
// exercise, a workout and its sets through their schemas, so a property runs
// fewer iterations than one over a single value.
const RUNS = numRunsFor({ base: 30 })

const strongLifts = StrongLifts5x5.trainingPlanDefinition('plan-1')

/** An id for each resource a submission writes, the same on every call — as a retrying app mints them. */
const mintId = (idToMint: PlannedWorkout.IdToMint): string => {
  if (idToMint.resourceType === 'Procedure') return 'workout-1'
  if (idToMint.resourceType === 'Observation')
    return `set-${idToMint.exerciseId}-${idToMint.setIndex}`
  return `sr-next-${idToMint.exerciseId}`
}

/** The exercise id an `ExerciseRequest` asks for. */
const exerciseIdOf = (exerciseRequest: ExerciseRequest.Type): string =>
  ExerciseConcept.idOf(ExerciseRequest.exerciseOf(exerciseRequest))

/** `trainingPlanDefinition` started at `startingLoads`, each `ServiceRequest` stored as `sr-<exercise id>`. */
const started = ({
  trainingPlanDefinition,
  startingLoads,
}: {
  readonly trainingPlanDefinition: TrainingPlanDefinition.Type
  readonly startingLoads: ExerciseRequest.StartingLoads
}): readonly ExerciseRequest.Type[] =>
  made(
    ExerciseRequest.makeForEachExercise({
      subject: SUBJECT,
      trainingPlanDefinition,
      startingLoads,
      mintServiceRequestId: (exerciseId) => `sr-${exerciseId}`,
      authoredOn: AUTHORED_ON,
    })
  )

/** `trainingPlanDefinition` started with every load at its rule's floor. */
const startedAtFloor = (
  trainingPlanDefinition: TrainingPlanDefinition.Type
): readonly ExerciseRequest.Type[] =>
  started({ trainingPlanDefinition, startingLoads: startingLoadsAtFloorOf(trainingPlanDefinition) })

/** What a lifter has on file: their `ExerciseRequest`s, workouts and sets. */
interface OnFile {
  readonly exerciseRequests: readonly ExerciseRequest.Type[]
  readonly workoutProcedures: readonly WorkoutProcedure.Type[]
  readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
}

/** What is on file once a submission is written: each progressed `ExerciseRequest` replaced, and the new resources added. */
const written = (onFile: OnFile, submitted: PlannedWorkout.Submitted): OnFile => ({
  exerciseRequests: [
    ...onFile.exerciseRequests.map((exerciseRequest) =>
      Option.getOrElse(
        Arr.findFirst(
          submitted.exerciseRequestProgresses,
          ({ current }) => current.id === exerciseRequest.id
        ).pipe(Option.map(({ current }) => current)),
        () => exerciseRequest
      )
    ),
    ...submitted.exerciseRequestProgresses.flatMap(({ next }) => Option.toArray(next)),
  ],
  workoutProcedures: [...onFile.workoutProcedures, submitted.workoutProcedure],
  exerciseSetObservations: [
    ...onFile.exerciseSetObservations,
    ...submitted.exerciseSetObservations,
  ],
})

/** The decision, the exercise and the load of each exercise's progression. */
const progressSummaryOf = (submitted: PlannedWorkout.Submitted): readonly unknown[] =>
  submitted.exerciseRequestProgresses.map(({ decision, current, next }) => [
    exerciseIdOf(current),
    decision,
    current.status,
    Option.map(next, (exerciseRequest) => Load.valueOf(ExerciseRequest.loadOf(exerciseRequest))),
  ])

const START = DateTime.unsafeMake('2026-02-02T18:00:00Z')
const END = DateTime.unsafeMake('2026-02-02T19:00:00Z')

/** A training plan definition started at its floors, and the planned workout due first. */
const firstPlannedWorkoutArb = trainingPlanDefinitionArb.map((trainingPlanDefinition) => {
  const exerciseRequests = startedAtFloor(trainingPlanDefinition)
  return {
    trainingPlanDefinition,
    exerciseRequests,
    plannedWorkout: made(
      PlannedWorkout.make({
        trainingPlanDefinition,
        exerciseRequests,
        workoutProcedures: [],
        exerciseSetObservations: [],
      })
    ),
  }
})

describe('PlannedWorkout.make', () => {
  it("should plan StrongLifts' day A first: squat, bench press and barbell row at the starting loads, no failures yet", () => {
    // Act
    const plannedWorkout = made(
      PlannedWorkout.make({
        trainingPlanDefinition: strongLifts,
        exerciseRequests: started({
          trainingPlanDefinition: strongLifts,
          startingLoads: StrongLifts5x5.STARTING_LOADS,
        }),
        workoutProcedures: [],
        exerciseSetObservations: [],
      })
    )

    // Assert
    expect(TrainingPlanDefinition.Day.labelOf(plannedWorkout.trainingPlanDefinitionDay)).toBe('A')
    expect(
      plannedWorkout.plannedWorkoutExercises.map((plannedWorkoutExercise) => [
        PlannedWorkout.exerciseIdOf(plannedWorkoutExercise),
        Load.valueOf(ExerciseRequest.loadOf(plannedWorkoutExercise.exerciseRequest)),
        ExerciseRequest.setsOf(plannedWorkoutExercise.exerciseRequest),
        ExerciseRequest.repsOf(plannedWorkoutExercise.exerciseRequest),
        PlannedWorkout.consecutiveFailuresOf(plannedWorkoutExercise),
        PlannedWorkout.failuresBeforeDeloadOf(plannedWorkoutExercise),
      ])
    ).toEqual([
      ['squat', 45, 5, 5, 0, 3],
      ['bench-press', 45, 5, 5, 0, 3],
      ['barbell-row', 65, 5, 5, 0, 3],
    ])
  })

  it('should plan the first day, each exercise once in the order it first runs it, with its own ExerciseRequest', () => {
    fc.assert(
      fc.property(firstPlannedWorkoutArb, ({ trainingPlanDefinition, plannedWorkout }) => {
        const firstDay = Arr.headNonEmpty(TrainingPlanDefinition.daysOf(trainingPlanDefinition))
        expect(plannedWorkout.trainingPlanDefinitionDay).toBe(firstDay)
        expect(plannedWorkout.plannedWorkoutExercises.map(PlannedWorkout.exerciseIdOf)).toEqual(
          Arr.dedupe(
            TrainingPlanDefinition.Day.exercisesOf(firstDay).map(
              TrainingPlanDefinition.Exercise.exerciseIdOf
            )
          )
        )
        for (const plannedWorkoutExercise of plannedWorkout.plannedWorkoutExercises) {
          expect(exerciseIdOf(plannedWorkoutExercise.exerciseRequest)).toBe(
            PlannedWorkout.exerciseIdOf(plannedWorkoutExercise)
          )
          expect(plannedWorkoutExercise.attempts).toEqual([])
        }
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a day whose exercises have no active ExerciseRequest or several, naming every one', () => {
    fc.assert(
      fc.property(
        firstPlannedWorkoutArb.chain(({ trainingPlanDefinition, exerciseRequests }) =>
          fc.record({
            trainingPlanDefinition: fc.constant(trainingPlanDefinition),
            exerciseRequests: fc.constant(exerciseRequests),
            // For each exercise: keep its one `ExerciseRequest`, drop it, or double it.
            counts: fc.array(fc.constantFrom(0, 1, 2), {
              minLength: exerciseRequests.length,
              maxLength: exerciseRequests.length,
            }),
          })
        ),
        ({ trainingPlanDefinition, exerciseRequests, counts }) => {
          // Arrange
          const onFile = exerciseRequests.flatMap((exerciseRequest, index) =>
            Array.from({ length: counts[index] ?? 1 }, (_, copy) => ({
              ...exerciseRequest,
              id: `${exerciseRequest.id}-${copy}`,
            }))
          )
          const firstDay = Arr.headNonEmpty(TrainingPlanDefinition.daysOf(trainingPlanDefinition))
          const expected = Arr.dedupe(
            TrainingPlanDefinition.Day.exercisesOf(firstDay).map(
              TrainingPlanDefinition.Exercise.exerciseIdOf
            )
          ).flatMap((exerciseId) => {
            const serviceRequestIds = onFile
              .filter((exerciseRequest) => exerciseIdOf(exerciseRequest) === exerciseId)
              .map((exerciseRequest) => exerciseRequest.id)
            return serviceRequestIds.length === 1 ? [] : [{ exerciseId, serviceRequestIds }]
          })

          // Act
          const planned = PlannedWorkout.make({
            trainingPlanDefinition,
            exerciseRequests: onFile,
            workoutProcedures: [],
            exerciseSetObservations: [],
          })

          // Assert
          Either.match(planned, {
            onRight: () => expect(expected).toEqual([]),
            onLeft: (refusal) => {
              expect(refusal).toBeInstanceOf(PlannedWorkout.ExerciseNotRequestedOnce)
              expect(refusal.exercises).toEqual(expected)
              expect(refusal.dayLabel).toBe(TrainingPlanDefinition.Day.labelOf(firstDay))
            },
          })
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should pass over closed ExerciseRequests, and ExerciseRequests and workouts of another training plan definition', () => {
    // Arrange
    const exerciseRequests = startedAtFloor(strongLifts)
    const otherTrainingPlanDefinition = StrongLifts5x5.trainingPlanDefinition('plan-2')
    const otherExerciseRequests = startedAtFloor(otherTrainingPlanDefinition)
    const otherWorkout = made(
      WorkoutProcedure.complete(
        made(
          WorkoutProcedure.make({
            procedureId: 'workout-0',
            subject: SUBJECT,
            trainingPlanDefinition: otherTrainingPlanDefinition,
            trainingPlanDefinitionDay: Arr.headNonEmpty(
              TrainingPlanDefinition.daysOf(otherTrainingPlanDefinition)
            ),
            exerciseRequests: otherExerciseRequests,
            start: START,
          })
        ),
        END
      )
    )

    // Act
    const plannedWorkout = made(
      PlannedWorkout.make({
        trainingPlanDefinition: strongLifts,
        exerciseRequests: [
          ...exerciseRequests,
          ...otherExerciseRequests,
          ...exerciseRequests.map((exerciseRequest) => ({
            ...ExerciseRequest.close(exerciseRequest, 'completed'),
            id: `${exerciseRequest.id}-closed`,
          })),
        ],
        workoutProcedures: [otherWorkout],
        exerciseSetObservations: [],
      })
    )

    // Assert
    expect(TrainingPlanDefinition.Day.labelOf(plannedWorkout.trainingPlanDefinitionDay)).toBe('A')
    expect(
      plannedWorkout.plannedWorkoutExercises.map(({ exerciseRequest }) => exerciseRequest)
    ).toEqual(
      ['squat', 'bench-press', 'barbell-row'].map((exerciseId) =>
        someOrFail(ExerciseRequest.forExercise(exerciseRequests, exerciseId))
      )
    )
  })
})

describe('PlannedWorkout.submit', () => {
  it('should complete day A: sets over the workout span, the met squat up, the failed bench held, the skipped row untouched', () => {
    // Arrange
    const plannedWorkout = made(
      PlannedWorkout.make({
        trainingPlanDefinition: strongLifts,
        exerciseRequests: started({
          trainingPlanDefinition: strongLifts,
          startingLoads: StrongLifts5x5.STARTING_LOADS,
        }),
        workoutProcedures: [],
        exerciseSetObservations: [],
      })
    )
    const barbellRow = someOrFail(Arr.last(plannedWorkout.plannedWorkoutExercises)).exerciseRequest

    // Act
    const submitted = made(
      PlannedWorkout.submit({
        plannedWorkout,
        subject: SUBJECT,
        start: START,
        end: END,
        setRepsByExerciseId: { squat: [5, 5, 5, 5, 5], 'bench-press': [5, 5, 5, 4, 3] },
        mintId,
      })
    )

    // Assert
    expect([
      submitted.workoutProcedure.id,
      submitted.workoutProcedure.status,
      WorkoutProcedure.dayLabelOf(submitted.workoutProcedure),
      WorkoutProcedure.serviceRequestIdsOf(submitted.workoutProcedure),
      submitted.workoutProcedure.performedPeriod.end,
    ]).toEqual([
      'workout-1',
      'completed',
      'A',
      ['sr-squat', 'sr-bench-press', 'sr-barbell-row'],
      END,
    ])
    expect(
      submitted.exerciseSetObservations.map((exerciseSetObservation) => [
        exerciseSetObservation.id,
        ExerciseSetObservation.serviceRequestIdOf(exerciseSetObservation),
        ExerciseSetObservation.procedureIdOf(exerciseSetObservation),
        ExerciseSetObservation.repsOf(exerciseSetObservation),
      ])
    ).toEqual([
      ...[5, 5, 5, 5, 5].map((reps, setIndex) => [
        `set-squat-${setIndex}`,
        'sr-squat',
        'workout-1',
        reps,
      ]),
      ...[5, 5, 5, 4, 3].map((reps, setIndex) => [
        `set-bench-press-${setIndex}`,
        'sr-bench-press',
        'workout-1',
        reps,
      ]),
    ])
    expect(progressSummaryOf(submitted)).toEqual([
      ['squat', 'increment', 'completed', Option.some(50)],
      ['bench-press', 'hold', 'active', Option.none()],
      ['barbell-row', 'hold', 'active', Option.none()],
    ])
    const squatNext = someOrFail(someOrFail(Arr.head(submitted.exerciseRequestProgresses)).next)
    expect([squatNext.id, squatNext.authoredOn]).toEqual(['sr-next-squat', DateTime.formatIso(END)])
    expect(someOrFail(Arr.last(submitted.exerciseRequestProgresses)).current).toBe(barbellRow)
  })

  it('should write a set per rep count entered over the workout span, and progress each exercise with sets as ExerciseRequest.progress does', () => {
    fc.assert(
      fc.property(
        firstPlannedWorkoutArb.chain(({ plannedWorkout }) =>
          fc.record({
            plannedWorkout: fc.constant(plannedWorkout),
            setReps: fc.tuple(
              ...plannedWorkout.plannedWorkoutExercises.map(() =>
                fc.array(fc.nat({ max: 25 }), { maxLength: 6 })
              )
            ),
            start: instantArb,
            lengthMillis: fc.nat({ max: 4 * 3_600_000 }),
          })
        ),
        ({ plannedWorkout, setReps, start, lengthMillis }) => {
          // Arrange
          const end = DateTime.addDuration(start, `${lengthMillis} millis`)
          const submission = {
            plannedWorkout,
            subject: SUBJECT,
            start,
            end,
            setRepsByExerciseId: Object.fromEntries(
              plannedWorkout.plannedWorkoutExercises.map((plannedWorkoutExercise, index) => [
                PlannedWorkout.exerciseIdOf(plannedWorkoutExercise),
                setReps[index] ?? [],
              ])
            ),
            mintId,
          }

          // Act
          const submitted = made(PlannedWorkout.submit(submission))

          // Assert
          expect(PlannedWorkout.submit(submission)).toEqual(Either.right(submitted))
          expect(WorkoutProcedure.isCompleted(submitted.workoutProcedure)).toBe(true)
          expect(submitted.exerciseSetObservations.map(ExerciseSetObservation.repsOf)).toEqual(
            setReps.flat()
          )
          for (const exerciseSetObservation of submitted.exerciseSetObservations) {
            expect([
              ExerciseSetObservation.startOf(exerciseSetObservation),
              ExerciseSetObservation.endOf(exerciseSetObservation),
            ]).toEqual([start, end])
          }
          plannedWorkout.plannedWorkoutExercises.forEach((plannedWorkoutExercise, index) => {
            const progress = submitted.exerciseRequestProgresses[index]
            const exerciseSetObservations = submitted.exerciseSetObservations.filter(
              (exerciseSetObservation) =>
                ExerciseSetObservation.serviceRequestIdOf(exerciseSetObservation) ===
                plannedWorkoutExercise.exerciseRequest.id
            )
            if (Arr.isEmptyReadonlyArray(exerciseSetObservations)) {
              expect(progress?.decision).toBe('hold')
              expect(progress?.current).toBe(plannedWorkoutExercise.exerciseRequest)
              expect(progress?.next).toEqual(Option.none())
            } else {
              expect(progress).toEqual(
                made(
                  ExerciseRequest.progress({
                    exerciseRequest: plannedWorkoutExercise.exerciseRequest,
                    progressionRule: TrainingPlanDefinition.Exercise.progressionRuleOf(
                      plannedWorkoutExercise.trainingPlanDefinitionExercise
                    ),
                    workoutProcedures: [submitted.workoutProcedure],
                    exerciseSetObservations,
                    nextServiceRequestId: `sr-next-${PlannedWorkout.exerciseIdOf(plannedWorkoutExercise)}`,
                    authoredOn: end,
                  })
                )
              )
            }
          })
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse reps for an exercise the day does not run, naming every one', () => {
    // Arrange
    const plannedWorkout = made(
      PlannedWorkout.make({
        trainingPlanDefinition: strongLifts,
        exerciseRequests: startedAtFloor(strongLifts),
        workoutProcedures: [],
        exerciseSetObservations: [],
      })
    )

    // Act
    const refused = PlannedWorkout.submit({
      plannedWorkout,
      subject: SUBJECT,
      start: START,
      end: END,
      setRepsByExerciseId: { squat: [5], deadlift: [5], 'overhead-press': [5] },
      mintId,
    })

    // Assert
    expect(refused).toEqual(
      Either.left(
        new PlannedWorkout.ExerciseNotInPlannedWorkout({
          exerciseIds: ['deadlift', 'overhead-press'],
          dayLabel: 'A',
        })
      )
    )
  })

  it('should refuse an end before the start, and negative reps', () => {
    // Arrange
    const plannedWorkout = made(
      PlannedWorkout.make({
        trainingPlanDefinition: strongLifts,
        exerciseRequests: startedAtFloor(strongLifts),
        workoutProcedures: [],
        exerciseSetObservations: [],
      })
    )
    const messageOf = ({
      end,
      reps,
    }: {
      readonly end: DateTime.Utc
      readonly reps: number
    }): string =>
      Either.match(
        PlannedWorkout.submit({
          plannedWorkout,
          subject: SUBJECT,
          start: START,
          end,
          setRepsByExerciseId: { squat: [reps] },
          mintId,
        }),
        { onLeft: (error) => error.message, onRight: () => '' }
      )

    // Assert
    expect(messageOf({ end: DateTime.subtract(START, { minutes: 1 }), reps: 5 })).toContain(
      'expected the end at or after the start'
    )
    expect(messageOf({ end: END, reps: -1 })).toContain('valueInteger')
  })

  it('should alternate days and count failures across submissions, deloading the bench press on the third failure', () => {
    // Arrange: StrongLifts with the bench press above the bar, so a deload can lower it.
    let onFile: OnFile = {
      exerciseRequests: started({
        trainingPlanDefinition: strongLifts,
        startingLoads: {
          ...StrongLifts5x5.STARTING_LOADS,
          'bench-press': made(Load.make({ value: 100, unit: '[lb_av]' })),
        },
      }),
      workoutProcedures: [],
      exerciseSetObservations: [],
    }
    const seen: unknown[] = []

    // Act: five workouts, every lift met but the bench press, which fails each time.
    for (const workoutIndex of [0, 1, 2, 3, 4]) {
      const plannedWorkout = made(
        PlannedWorkout.make({ trainingPlanDefinition: strongLifts, ...onFile })
      )
      const submitted = made(
        PlannedWorkout.submit({
          plannedWorkout,
          subject: SUBJECT,
          start: DateTime.add(START, { days: workoutIndex }),
          end: DateTime.add(END, { days: workoutIndex }),
          setRepsByExerciseId: EffectRecord.fromEntries(
            plannedWorkout.plannedWorkoutExercises.map((plannedWorkoutExercise) => [
              PlannedWorkout.exerciseIdOf(plannedWorkoutExercise),
              PlannedWorkout.exerciseIdOf(plannedWorkoutExercise) === 'bench-press'
                ? [5, 5, 5, 5, 4]
                : Array.from(
                    { length: ExerciseRequest.setsOf(plannedWorkoutExercise.exerciseRequest) },
                    () => 5
                  ),
            ])
          ),
          mintId: (idToMint) => `${workoutIndex}-${mintId(idToMint)}`,
        })
      )
      seen.push([
        TrainingPlanDefinition.Day.labelOf(plannedWorkout.trainingPlanDefinitionDay),
        plannedWorkout.plannedWorkoutExercises.map((plannedWorkoutExercise) => [
          PlannedWorkout.exerciseIdOf(plannedWorkoutExercise),
          Load.valueOf(ExerciseRequest.loadOf(plannedWorkoutExercise.exerciseRequest)),
          PlannedWorkout.consecutiveFailuresOf(plannedWorkoutExercise),
        ]),
        submitted.exerciseRequestProgresses.map(({ decision }) => decision),
      ])
      onFile = written(onFile, submitted)
    }

    // Assert
    expect(seen).toEqual([
      [
        'A',
        [
          ['squat', 45, 0],
          ['bench-press', 100, 0],
          ['barbell-row', 65, 0],
        ],
        ['increment', 'hold', 'increment'],
      ],
      [
        'B',
        [
          ['squat', 50, 0],
          ['overhead-press', 45, 0],
          ['deadlift', 95, 0],
        ],
        ['increment', 'increment', 'increment'],
      ],
      [
        'A',
        [
          ['squat', 55, 0],
          ['bench-press', 100, 1],
          ['barbell-row', 70, 0],
        ],
        ['increment', 'hold', 'increment'],
      ],
      [
        'B',
        [
          ['squat', 60, 0],
          ['overhead-press', 50, 0],
          ['deadlift', 105, 0],
        ],
        ['increment', 'increment', 'increment'],
      ],
      [
        'A',
        [
          ['squat', 65, 0],
          ['bench-press', 100, 2],
          ['barbell-row', 75, 0],
        ],
        ['increment', 'deload', 'increment'],
      ],
    ])
    expect(
      onFile.exerciseRequests
        .filter((exerciseRequest) => exerciseRequest.status === 'active')
        .map((exerciseRequest) => [
          exerciseIdOf(exerciseRequest),
          Load.valueOf(ExerciseRequest.loadOf(exerciseRequest)),
        ])
    ).toEqual(
      expect.arrayContaining([
        ['squat', 70],
        ['bench-press', 90],
      ])
    )
  })
})
