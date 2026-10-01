import { Arbitrary, Array as Arr, DateTime, Either, Option, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { IdentifierAndReference, WildflowerCodeSystem } from 'fhir-r4/data-types'
import { Procedure } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as ExerciseRequest from '../exercise-request/exercise-request.ts'
import * as LiftingFeature from '../lifting-feature/lifting-feature.ts'
import * as StrongLifts5x5 from '../plans/strong-lifts.ts'
import {
  completedWorkoutAt,
  exerciseRequestArb,
  instantArb,
  issueMessagesOf,
  issuePathsOf,
  made,
  startedWorkoutAt,
  SUBJECT,
  throughWire,
} from '../test-helpers.ts'
import * as TrainingPlanDefinition from '../training-plan-definition/training-plan-definition.ts'
import * as WorkoutProcedure from './workout-procedure.ts'

const RUNS = numRunsFor({ base: 100 })

// A property over a list of sets or workouts makes each through its schema,
// so it runs fewer iterations than one over a single value.
const LIST_RUNS = numRunsFor({ base: 30 })

// Encode → JSON → decode of a whole Procedure is the slow path, so the wire
// round-trip runs fewer iterations than the in-memory properties.
const WIRE_RUNS = numRunsFor({ base: 50 })

/** A workout as the wire carries it: a `Procedure`, decoded and then narrowed. */
const WireWorkout = Schema.compose(Procedure.Schema, WorkoutProcedure.Schema)

const decode = Schema.decodeEither(WorkoutProcedure.Schema, { errors: 'all' })

const trainingPlanDefinition = StrongLifts5x5.trainingPlanDefinition('plan-1')
const [trainingPlanDefinitionDayA, trainingPlanDefinitionDayB] =
  TrainingPlanDefinition.daysOf(trainingPlanDefinition)

/** Any workout, started or completed, carrying out a generated `ExerciseRequest`. */
const workoutArb: fc.Arbitrary<WorkoutProcedure.Type> = fc
  .record({ exerciseRequest: exerciseRequestArb, index: fc.nat({ max: 30 }), done: fc.boolean() })
  .map(({ exerciseRequest, index, done }) =>
    done
      ? completedWorkoutAt({ exerciseRequest, index })
      : startedWorkoutAt({ exerciseRequest, index })
  )

describe('WorkoutProcedure', () => {
  it('should write a started workout as an in-progress Procedure coded with its day label', () => {
    fc.assert(
      fc.property(exerciseRequestArb, instantArb, (exerciseRequest, start) => {
        // Act
        const wire = Schema.encodeSync(WireWorkout)(
          made(
            WorkoutProcedure.make({
              procedureId: 'workout-1',
              subject: SUBJECT,
              trainingPlanDefinition,
              trainingPlanDefinitionDay:
                trainingPlanDefinitionDayB ??
                Arr.headNonEmpty(TrainingPlanDefinition.daysOf(trainingPlanDefinition)),
              exerciseRequests: [exerciseRequest],
              start,
            })
          )
        )

        // Assert
        expect(wire).toMatchObject({
          resourceType: 'Procedure',
          id: 'workout-1',
          status: 'in-progress',
          category: { coding: [{ code: LiftingFeature.CODE }] },
          code: { coding: [{ system: WildflowerCodeSystem.Workout, code: 'B', display: 'B' }] },
          subject: { reference: 'Patient/p-1' },
          instantiatesCanonical: [trainingPlanDefinition.url],
          basedOn: [{ reference: `ServiceRequest/${exerciseRequest.id}` }],
          performedPeriod: { start: DateTime.formatIso(start) },
        })
        expect(wire.performedPeriod?.end).toBeUndefined()
      }),
      { numRuns: RUNS }
    )
  })

  it('should read back every workout it makes and completes, through the wire', () => {
    fc.assert(
      fc.property(workoutArb, (workoutProcedure) => {
        const read = throughWire(WireWorkout, workoutProcedure)
        expect({
          status: read.status,
          label: WorkoutProcedure.dayLabelOf(read),
          start: DateTime.toEpochMillis(WorkoutProcedure.startOf(read)),
          end: Option.map(WorkoutProcedure.endOf(read), DateTime.toEpochMillis),
          trainingPlanDefinitionUrl: WorkoutProcedure.trainingPlanDefinitionUrlOf(read),
          serviceRequestIds: WorkoutProcedure.serviceRequestIdsOf(read),
        }).toEqual({
          status: workoutProcedure.status,
          label: WorkoutProcedure.dayLabelOf(workoutProcedure),
          start: DateTime.toEpochMillis(WorkoutProcedure.startOf(workoutProcedure)),
          end: Option.map(WorkoutProcedure.endOf(workoutProcedure), DateTime.toEpochMillis),
          trainingPlanDefinitionUrl: trainingPlanDefinition.url,
          serviceRequestIds: WorkoutProcedure.serviceRequestIdsOf(workoutProcedure),
        })
      }),
      { numRuns: WIRE_RUNS }
    )
  })

  it('should complete a workout at its end, and refuse an end before its start', () => {
    fc.assert(
      fc.property(exerciseRequestArb, fc.nat({ max: 7_200_000 }), (exerciseRequest, length) => {
        const started = startedWorkoutAt({ exerciseRequest, index: 3 })
        const start = WorkoutProcedure.startOf(started)
        const completed = WorkoutProcedure.complete(
          started,
          DateTime.addDuration(start, `${length} millis`)
        )
        expect(Either.map(completed, (workoutProcedure) => workoutProcedure.status)).toEqual(
          Either.right('completed')
        )
        expect(
          Either.map(completed, (workoutProcedure) =>
            Option.map(WorkoutProcedure.endOf(workoutProcedure), DateTime.toEpochMillis)
          )
        ).toEqual(Either.right(Option.some(DateTime.toEpochMillis(start) + length)))
        expect(
          issuePathsOf(
            WorkoutProcedure.complete(started, DateTime.subtractDuration(start, '1 millis'))
          )
        ).toEqual(['performedPeriod'])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a workout in any status but in-progress or completed, saying why', () => {
    fc.assert(
      fc.property(
        workoutArb,
        Arbitrary.make(Procedure.StatusSchema),
        (workoutProcedure, status) => {
          fc.pre(status !== 'in-progress' && status !== 'completed')
          const refused = decode({ ...workoutProcedure, status })
          expect(issuePathsOf(refused)).toEqual(['status'])
          expect(issueMessagesOf(refused).join()).toContain('not one progression reasons about')
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse an in-progress workout that has ended and a completed one that has not', () => {
    fc.assert(
      fc.property(workoutArb, (workoutProcedure) => {
        const flipped = {
          ...workoutProcedure,
          status:
            workoutProcedure.status === 'completed'
              ? ('in-progress' as const)
              : ('completed' as const),
        }
        expect(issuePathsOf(decode(flipped))).toEqual(['performedPeriod.end'])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse no ServiceRequest, no single training plan definition url or no workout coding, naming each', () => {
    fc.assert(
      fc.property(workoutArb, (workoutProcedure) => {
        const carePlan = IdentifierAndReference.referenceTo({ resourceType: 'CarePlan', id: 'c' })
        const [url] = workoutProcedure.instantiatesCanonical
        expect(issuePathsOf(decode({ ...workoutProcedure, basedOn: [] }))).toEqual(['basedOn.0'])
        expect(issuePathsOf(decode({ ...workoutProcedure, basedOn: [carePlan] }))).toEqual([
          'basedOn.0',
        ])
        expect(
          issuePathsOf(decode({ ...workoutProcedure, instantiatesCanonical: [url, url] }))
        ).toEqual(['instantiatesCanonical.1'])
        expect(
          issuePathsOf(
            decode({ ...workoutProcedure, code: { ...workoutProcedure.code, coding: [] } })
          )
        ).toEqual(['code.coding'])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse to make a workout that carries out no ExerciseRequest', () => {
    const workoutProcedure = WorkoutProcedure.make({
      procedureId: 'workout-1',
      subject: SUBJECT,
      trainingPlanDefinition,
      trainingPlanDefinitionDay:
        trainingPlanDefinitionDayA ??
        Arr.headNonEmpty(TrainingPlanDefinition.daysOf(trainingPlanDefinition)),
      exerciseRequests: [],
      start: DateTime.unsafeMake('2026-01-05T18:00:00Z'),
    })
    const parseError = Either.match(workoutProcedure, {
      onLeft: (error) => (ParseResult.isParseError(error) ? Option.some(error) : Option.none()),
      onRight: () => Option.none(),
    })
    expect(Option.map(parseError, (error) => issuePathsOf(Either.left(error)))).toEqual(
      Option.some(['basedOn.0'])
    )
  })

  it('should refuse to make a workout of a day the training plan definition does not cycle through, naming it', () => {
    fc.assert(
      fc.property(exerciseRequestArb, (exerciseRequest) => {
        // Arrange: a training plan definition of its own, whose only day is labelled `Z`.
        const [trainingPlanDefinitionExercise] = TrainingPlanDefinition.Day.exercisesOf(
          trainingPlanDefinitionDayA ??
            Arr.headNonEmpty(TrainingPlanDefinition.daysOf(trainingPlanDefinition))
        )
        const elsewhereTrainingPlanDefinitionDay = made(
          TrainingPlanDefinition.Day.make({
            label: 'Z',
            trainingPlanDefinitionExercises: [trainingPlanDefinitionExercise],
          })
        )

        // Act
        const refused = Either.flip(
          WorkoutProcedure.make({
            procedureId: 'workout-1',
            subject: SUBJECT,
            trainingPlanDefinition,
            trainingPlanDefinitionDay: elsewhereTrainingPlanDefinitionDay,
            exerciseRequests: [exerciseRequest],
            start: DateTime.unsafeMake('2026-01-05T18:00:00Z'),
          })
        )

        // Assert
        expect(refused).toEqual(
          Either.right(
            new WorkoutProcedure.DayNotInTrainingPlanDefinition({
              dayLabel: 'Z',
              trainingPlanDefinitionUrl: trainingPlanDefinition.url,
            })
          )
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse to make a workout carrying out an ExerciseRequest of another training plan definition, naming it', () => {
    fc.assert(
      fc.property(
        exerciseRequestArb,
        fc.webUrl(),
        (exerciseRequest, otherTrainingPlanDefinitionUrl) => {
          // Arrange
          fc.pre(otherTrainingPlanDefinitionUrl !== trainingPlanDefinition.url)
          const stray = made(
            Schema.decodeEither(ExerciseRequest.Schema)({
              ...exerciseRequest,
              id: 'sr-stray',
              instantiatesCanonical: [otherTrainingPlanDefinitionUrl],
            })
          )

          // Act
          const refused = Either.flip(
            WorkoutProcedure.make({
              procedureId: 'workout-1',
              subject: SUBJECT,
              trainingPlanDefinition,
              trainingPlanDefinitionDay:
                trainingPlanDefinitionDayA ??
                Arr.headNonEmpty(TrainingPlanDefinition.daysOf(trainingPlanDefinition)),
              exerciseRequests: [stray, exerciseRequest, { ...stray, id: 'sr-stray-2' }],
              start: DateTime.unsafeMake('2026-01-05T18:00:00Z'),
            })
          )

          // Assert
          expect(refused).toEqual(
            Either.right(
              new WorkoutProcedure.ExerciseRequestNotOfTrainingPlanDefinition({
                serviceRequestIds: ['sr-stray', 'sr-stray-2'],
                trainingPlanDefinitionUrl: trainingPlanDefinition.url,
              })
            )
          )
          expect(Either.map(refused, (error) => error.message)).toEqual(
            Either.right(
              `the ServiceRequests "sr-stray", "sr-stray-2" do not follow the training plan definition ${trainingPlanDefinition.url}`
            )
          )
        }
      ),
      { numRuns: RUNS }
    )
  })
})

describe('latestCompleted / completedByStart', () => {
  it('should order the completed workouts by start and never count one in progress', () => {
    fc.assert(
      fc.property(fc.array(workoutArb, { maxLength: 6 }), (workoutProcedures) => {
        const completed = WorkoutProcedure.completedByStart(workoutProcedures)
        const starts = completed.map((workoutProcedure) =>
          DateTime.toEpochMillis(WorkoutProcedure.startOf(workoutProcedure))
        )
        expect(completed.every(WorkoutProcedure.isCompleted)).toBe(true)
        expect(completed).toHaveLength(
          workoutProcedures.filter(WorkoutProcedure.isCompleted).length
        )
        expect(starts).toEqual(starts.toSorted((a, b) => a - b))
        expect(WorkoutProcedure.latestCompleted(workoutProcedures)).toEqual(Arr.last(completed))
      }),
      { numRuns: LIST_RUNS }
    )
  })
})
