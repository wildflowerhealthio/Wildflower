import { Arbitrary, DateTime, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { CodeableConcept, IdentifierAndReference } from 'fhir-r4/data-types'
import { Observation } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as ExerciseRequest from '../exercise-request/exercise-request.ts'
import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import * as StrongLifts5x5 from '../plans/strong-lifts.ts'
import {
  AUTHORED_ON,
  completedWorkoutAt,
  exerciseRequestArb,
  instantArb,
  issuePathsOf,
  made,
  SUBJECT,
  throughWire,
} from '../test-helpers.ts'
import * as ExerciseSetObservation from './exercise-set-observation.ts'

const RUNS = numRunsFor({ base: 100 })

// A property over a list of sets or workouts makes each through its schema,
// so it runs fewer iterations than one over a single value.
const LIST_RUNS = numRunsFor({ base: 30 })

// Encode → JSON → decode of a whole Observation is the slow path, so the wire
// round-trip runs fewer iterations than the in-memory properties.
const WIRE_RUNS = numRunsFor({ base: 50 })

/** A set as the wire carries it: an `Observation`, decoded and then narrowed. */
const WireExerciseSetObservation = Schema.compose(Observation.Schema, ExerciseSetObservation.Schema)

/**
 * What a set is made of: an `ExerciseRequest`, the workout carrying it out, a
 * start, a length up to ten minutes, and any count of reps.
 */
const exerciseSetObservationInputArb = fc
  .record({
    exerciseRequest: exerciseRequestArb,
    workoutIndex: fc.nat({ max: 30 }),
    start: instantArb,
    lengthMillis: fc.nat({ max: 600_000 }),
    reps: fc.nat({ max: 30 }),
  })
  .map(({ lengthMillis, workoutIndex, ...exerciseSetObservationInput }) => ({
    ...exerciseSetObservationInput,
    workoutProcedure: completedWorkoutAt({
      exerciseRequest: exerciseSetObservationInput.exerciseRequest,
      index: workoutIndex,
    }),
    observationId: 'obs-1',
    end: DateTime.addDuration(exerciseSetObservationInput.start, `${lengthMillis} millis`),
  }))

/** Any exercise set observation, as made. */
const exerciseSetObservationArb: fc.Arbitrary<ExerciseSetObservation.Type> =
  exerciseSetObservationInputArb.map((input) => made(ExerciseSetObservation.make(input)))

const squatExerciseRequest = made(
  ExerciseRequest.make({
    serviceRequestId: 'sr-2',
    subject: SUBJECT,
    trainingPlanDefinition: StrongLifts5x5.trainingPlanDefinition('plan-1'),
    exerciseId: 'squat',
    load: StrongLifts5x5.STARTING_LOADS.squat,
    authoredOn: AUTHORED_ON,
  })
)

describe('ExerciseSetObservation', () => {
  it('should write a squat set as a final activity Observation based on its `ServiceRequest`, part of its workout', () => {
    // Act
    const wire = Schema.encodeSync(WireExerciseSetObservation)(
      made(
        ExerciseSetObservation.make({
          observationId: 'obs-1',
          exerciseRequest: squatExerciseRequest,
          workoutProcedure: completedWorkoutAt({ exerciseRequest: squatExerciseRequest, index: 4 }),
          start: DateTime.unsafeMake('2026-01-05T18:00:00Z'),
          end: DateTime.unsafeMake('2026-01-05T18:00:40Z'),
          reps: 4,
        })
      )
    )

    // Assert
    expect(wire).toMatchObject({
      id: 'obs-1',
      status: 'final',
      category: [{ coding: [{ system: Observation.CATEGORY_SYSTEM, code: 'activity' }] }],
      code: { text: 'Squat', coding: [{ code: 'squat', display: 'Squat' }] },
      subject: { reference: 'Patient/p-1' },
      basedOn: [{ reference: 'ServiceRequest/sr-2' }],
      partOf: [{ reference: 'Procedure/workout-4' }],
      effectivePeriod: { start: '2026-01-05T18:00:00.000Z', end: '2026-01-05T18:00:40.000Z' },
      valueInteger: 4,
    })
    expect(wire.extension ?? []).toEqual([])
  })

  it('should read back every set it makes, with its `ServiceRequest` and its workout, through the wire', () => {
    fc.assert(
      fc.property(exerciseSetObservationInputArb, (input) => {
        const exerciseSetObservation = throughWire(
          WireExerciseSetObservation,
          made(ExerciseSetObservation.make(input))
        )
        expect({
          exerciseId: ExerciseConcept.idOf(
            ExerciseSetObservation.exerciseOf(exerciseSetObservation)
          ),
          procedureId: ExerciseSetObservation.procedureIdOf(exerciseSetObservation),
          start: DateTime.toEpochMillis(ExerciseSetObservation.startOf(exerciseSetObservation)),
          end: DateTime.toEpochMillis(ExerciseSetObservation.endOf(exerciseSetObservation)),
          reps: ExerciseSetObservation.repsOf(exerciseSetObservation),
          serviceRequestId: ExerciseSetObservation.serviceRequestIdOf(exerciseSetObservation),
        }).toEqual({
          exerciseId: ExerciseConcept.idOf(ExerciseRequest.exerciseOf(input.exerciseRequest)),
          procedureId: input.workoutProcedure.id,
          start: DateTime.toEpochMillis(input.start),
          end: DateTime.toEpochMillis(input.end),
          reps: input.reps,
          serviceRequestId: input.exerciseRequest.id,
        })
      }),
      { numRuns: WIRE_RUNS }
    )
  })

  it('should refuse a retracted observation, and read any other status', () => {
    fc.assert(
      fc.property(
        exerciseSetObservationArb,
        Arbitrary.make(Observation.StatusSchema),
        (exerciseSetObservation, status) => {
          const read = Schema.decodeEither(ExerciseSetObservation.Schema)({
            ...exerciseSetObservation,
            status,
          })
          expect(issuePathsOf(read)).toEqual(
            Observation.RETRACTED_STATUSES.has(status) ? ['status'] : []
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse a period missing either end, or ending before it starts', () => {
    fc.assert(
      fc.property(
        exerciseSetObservationArb,
        fc.constantFrom(
          'none' as const,
          'startOnly' as const,
          'endOnly' as const,
          'backwards' as const
        ),
        (exerciseSetObservation, mutation) => {
          // Arrange
          const period = exerciseSetObservation.effectivePeriod
          const effectivePeriod = {
            none: null,
            startOnly: { ...period, end: null },
            endOnly: { ...period, start: null },
            backwards: { ...period, start: DateTime.addDuration(period.end, '1 millis') },
          }[mutation]

          // Act
          const paths = issuePathsOf(
            Schema.decodeEither(ExerciseSetObservation.Schema)({
              ...exerciseSetObservation,
              effectivePeriod,
            })
          )

          // Assert
          expect(paths.length).toBeGreaterThan(0)
          expect(paths.every((path) => path.startsWith('effectivePeriod'))).toBe(true)
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse reps that are missing, negative or fractional', () => {
    fc.assert(
      fc.property(
        exerciseSetObservationArb,
        fc.constantFrom(null, -1, 2.5),
        (exerciseSetObservation, valueInteger) => {
          const read = Schema.decodeEither(ExerciseSetObservation.Schema)({
            ...exerciseSetObservation,
            valueInteger,
          })
          expect(issuePathsOf(read)).toEqual(['valueInteger'])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should read the `ServiceRequest` beside references to other resources, and refuse none or two', () => {
    fc.assert(
      fc.property(exerciseSetObservationArb, (exerciseSetObservation) => {
        const decode = Schema.decodeEither(ExerciseSetObservation.Schema)
        const carePlan = IdentifierAndReference.referenceTo({
          resourceType: 'CarePlan',
          id: 'cp-1',
        })
        const other = IdentifierAndReference.referenceTo({
          resourceType: 'ServiceRequest',
          id: 'sr-9',
        })
        expect(
          Either.map(
            decode({
              ...exerciseSetObservation,
              basedOn: [carePlan, ...exerciseSetObservation.basedOn],
            }),
            ExerciseSetObservation.serviceRequestIdOf
          )
        ).toEqual(Either.right(ExerciseSetObservation.serviceRequestIdOf(exerciseSetObservation)))
        expect(issuePathsOf(decode({ ...exerciseSetObservation, basedOn: [carePlan] }))).toEqual([
          'basedOn',
        ])
        expect(
          issuePathsOf(
            decode({
              ...exerciseSetObservation,
              basedOn: [...exerciseSetObservation.basedOn, other],
            })
          )
        ).toEqual(['basedOn'])
      }),
      { numRuns: RUNS }
    )
  })

  it('should read the workout beside references to other resources, and refuse none or two', () => {
    fc.assert(
      fc.property(exerciseSetObservationArb, (exerciseSetObservation) => {
        const decode = Schema.decodeEither(ExerciseSetObservation.Schema)
        const imaging = IdentifierAndReference.referenceTo({
          resourceType: 'ImagingStudy',
          id: 'is-1',
        })
        const other = IdentifierAndReference.referenceTo({ resourceType: 'Procedure', id: 'p-9' })
        expect(
          Either.map(
            decode({
              ...exerciseSetObservation,
              partOf: [imaging, ...exerciseSetObservation.partOf],
            }),
            ExerciseSetObservation.procedureIdOf
          )
        ).toEqual(Either.right(ExerciseSetObservation.procedureIdOf(exerciseSetObservation)))
        expect(issuePathsOf(decode({ ...exerciseSetObservation, partOf: [imaging] }))).toEqual([
          'partOf',
        ])
        expect(
          issuePathsOf(
            decode({ ...exerciseSetObservation, partOf: [...exerciseSetObservation.partOf, other] })
          )
        ).toEqual(['partOf'])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse an exercise coding with no display', () => {
    fc.assert(
      fc.property(exerciseSetObservationArb, (exerciseSetObservation) => {
        const decode = Schema.decodeEither(ExerciseSetObservation.Schema)
        const nameless = {
          ...exerciseSetObservation.code,
          coding: exerciseSetObservation.code.coding.map((coding) => ({
            ...coding,
            display: null,
          })),
        }
        expect(issuePathsOf(decode({ ...exerciseSetObservation, code: nameless }))).toEqual([
          'code.coding.0.display',
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a foreign observation, naming every field it lacks', () => {
    fc.assert(
      fc.property(Arbitrary.make(CodeableConcept.Schema), (code) => {
        // Arrange
        const foreign = Schema.decodeUnknownSync(Observation.Schema)({
          resourceType: 'Observation',
          id: 'obs-9',
          status: 'final',
          code: Schema.encodeSync(CodeableConcept.Schema)(code),
        })

        // Act
        const paths = issuePathsOf(
          Schema.decodeEither(ExerciseSetObservation.Schema, { errors: 'all' })(foreign)
        )

        // Assert
        expect(paths).toEqual(expect.arrayContaining(['effectivePeriod', 'valueInteger']))
        expect(paths.some((path) => path.startsWith('code'))).toBe(true)
      }),
      { numRuns: RUNS }
    )
  })
})

describe('sortByStart', () => {
  it('should order sets earliest first, keeping the input order of sets started together', () => {
    fc.assert(
      fc.property(
        fc.array(exerciseSetObservationArb, { maxLength: 6 }),
        (exerciseSetObservations) => {
          const sorted = ExerciseSetObservation.sortByStart(exerciseSetObservations)
          const starts = sorted.map((exerciseSetObservation) =>
            DateTime.toEpochMillis(ExerciseSetObservation.startOf(exerciseSetObservation))
          )
          expect(starts).toEqual(starts.toSorted((a, b) => a - b))
          expect(sorted).toHaveLength(exerciseSetObservations.length)
          expect(
            exerciseSetObservations.every((exerciseSetObservation) =>
              sorted.includes(exerciseSetObservation)
            )
          ).toBe(true)
        }
      ),
      { numRuns: LIST_RUNS }
    )
  })
})
