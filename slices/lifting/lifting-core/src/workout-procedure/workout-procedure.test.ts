import { Arbitrary, Array as Arr, DateTime, Either, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { IdentifierAndReference, WildflowerCodeSystem } from 'fhir-r4/data-types'
import { Procedure } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as LiftingFeature from '../lifting-feature/lifting-feature.ts'
import * as Plan from '../plan/plan.ts'
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

const plan = StrongLifts5x5.plan('plan-1')
const [workoutA, workoutB] = Plan.workoutsOf(plan)

/** Any workout, started or completed, carrying out a generated `ExerciseRequest`. */
const workoutArb: fc.Arbitrary<WorkoutProcedure.Type> = fc
  .record({ exerciseRequest: exerciseRequestArb, index: fc.nat({ max: 30 }), done: fc.boolean() })
  .map(({ exerciseRequest, index, done }) =>
    done
      ? completedWorkoutAt({ exerciseRequest, index })
      : startedWorkoutAt({ exerciseRequest, index })
  )

describe('WorkoutProcedure', () => {
  it('should write a started workout as an in-progress Procedure coded with its label', () => {
    fc.assert(
      fc.property(exerciseRequestArb, instantArb, (exerciseRequest, start) => {
        // Act
        const wire = Schema.encodeSync(WireWorkout)(
          made(
            WorkoutProcedure.make({
              procedureId: 'workout-1',
              subject: SUBJECT,
              plan,
              workout: workoutB ?? Arr.headNonEmpty(Plan.workoutsOf(plan)),
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
          instantiatesCanonical: [plan.url],
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
      fc.property(workoutArb, (workout) => {
        const read = throughWire(WireWorkout, workout)
        expect({
          status: read.status,
          label: WorkoutProcedure.workoutLabelOf(read),
          start: DateTime.toEpochMillis(WorkoutProcedure.startOf(read)),
          end: Option.map(WorkoutProcedure.endOf(read), DateTime.toEpochMillis),
          planUrl: WorkoutProcedure.planUrlOf(read),
          serviceRequestIds: WorkoutProcedure.serviceRequestIdsOf(read),
        }).toEqual({
          status: workout.status,
          label: WorkoutProcedure.workoutLabelOf(workout),
          start: DateTime.toEpochMillis(WorkoutProcedure.startOf(workout)),
          end: Option.map(WorkoutProcedure.endOf(workout), DateTime.toEpochMillis),
          planUrl: plan.url,
          serviceRequestIds: WorkoutProcedure.serviceRequestIdsOf(workout),
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
        expect(Either.map(completed, (workout) => workout.status)).toEqual(
          Either.right('completed')
        )
        expect(
          Either.map(completed, (workout) =>
            Option.map(WorkoutProcedure.endOf(workout), DateTime.toEpochMillis)
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
      fc.property(workoutArb, Arbitrary.make(Procedure.StatusSchema), (workout, status) => {
        fc.pre(status !== 'in-progress' && status !== 'completed')
        const refused = decode({ ...workout, status })
        expect(issuePathsOf(refused)).toEqual(['status'])
        expect(issueMessagesOf(refused).join()).toContain('not one progression reasons about')
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse an in-progress workout that has ended and a completed one that has not', () => {
    fc.assert(
      fc.property(workoutArb, (workout) => {
        const flipped = {
          ...workout,
          status:
            workout.status === 'completed' ? ('in-progress' as const) : ('completed' as const),
        }
        expect(issuePathsOf(decode(flipped))).toEqual(['performedPeriod.end'])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse no ServiceRequest, no single plan url or no workout coding, naming each', () => {
    fc.assert(
      fc.property(workoutArb, (workout) => {
        const carePlan = IdentifierAndReference.referenceTo({ resourceType: 'CarePlan', id: 'c' })
        const [url] = workout.instantiatesCanonical
        expect(issuePathsOf(decode({ ...workout, basedOn: [] }))).toEqual(['basedOn.0'])
        expect(issuePathsOf(decode({ ...workout, basedOn: [carePlan] }))).toEqual(['basedOn.0'])
        expect(issuePathsOf(decode({ ...workout, instantiatesCanonical: [url, url] }))).toEqual([
          'instantiatesCanonical.1',
        ])
        expect(issuePathsOf(decode({ ...workout, code: { ...workout.code, coding: [] } }))).toEqual(
          ['code.coding']
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse to make a workout that carries out no ExerciseRequest', () => {
    const workout = WorkoutProcedure.make({
      procedureId: 'workout-1',
      subject: SUBJECT,
      plan,
      workout: workoutA ?? Arr.headNonEmpty(Plan.workoutsOf(plan)),
      exerciseRequests: [],
      start: DateTime.unsafeMake('2026-01-05T18:00:00Z'),
    })
    expect(issuePathsOf(workout)).toEqual(['basedOn.0'])
  })
})

describe('latestCompleted / completedByStart', () => {
  it('should order the completed workouts by start and never count one in progress', () => {
    fc.assert(
      fc.property(fc.array(workoutArb, { maxLength: 6 }), (workouts) => {
        const completed = WorkoutProcedure.completedByStart(workouts)
        const starts = completed.map((workout) =>
          DateTime.toEpochMillis(WorkoutProcedure.startOf(workout))
        )
        expect(completed.every(WorkoutProcedure.isCompleted)).toBe(true)
        expect(completed).toHaveLength(workouts.filter(WorkoutProcedure.isCompleted).length)
        expect(starts).toEqual(starts.toSorted((a, b) => a - b))
        expect(WorkoutProcedure.latestCompleted(workouts)).toEqual(Arr.last(completed))
      }),
      { numRuns: LIST_RUNS }
    )
  })
})
