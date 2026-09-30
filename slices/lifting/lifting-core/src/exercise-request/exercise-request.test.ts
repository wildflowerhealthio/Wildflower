import { Arbitrary, Array as Arr, DateTime, Either, Option, type ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { CodeableConcept, Code, Quantity, WildflowerExtension } from 'fhir-r4/data-types'
import { ServiceRequest } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as Session from '../exercise-set-observation/session.ts'
import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import { LiftingMeasureCode } from '../lifting-measure/lifting-measure.ts'
import * as Load from '../load/load.ts'
import * as Plan from '../plan/plan.ts'
import * as PlannedExercise from '../plan/planned-exercise.ts'
import * as StrongLifts5x5 from '../plans/strong-lifts.ts'
import {
  AUTHORED_ON,
  exerciseIdArb,
  exerciseRequestArb,
  failedRepsArb,
  issuePathsOf,
  made,
  planArb,
  plannedExerciseRequestArb,
  setAt,
  SUBJECT,
  successfulRepsArb,
  throughWire,
} from '../test-helpers.ts'
import * as ExerciseRequest from './exercise-request.ts'

const RUNS = numRunsFor({ base: 100 })

// Encode → JSON → decode of a whole ServiceRequest is the slow path, so the
// wire round-trip runs fewer iterations than the in-memory properties.
const WIRE_RUNS = numRunsFor({ base: 50 })

/** An `ExerciseRequest` as the wire carries it: a `ServiceRequest`, decoded and then narrowed. */
const WireExerciseRequest = Schema.compose(ServiceRequest.Schema, ExerciseRequest.Schema)

const decode = Schema.decodeEither(ExerciseRequest.Schema, { errors: 'all' })

const plan = StrongLifts5x5.plan('plan-1')

/** The StrongLifts squat at `value` lb, stored as `sr-2`. */
const squatAt = (value: number): ExerciseRequest.Type =>
  made(
    ExerciseRequest.make({
      serviceRequestId: 'sr-2',
      subject: SUBJECT,
      plan,
      exerciseId: 'squat',
      load: made(Load.make({ value, unit: 'lb' })),
      authoredOn: AUTHORED_ON,
    })
  )

/** What an `ExerciseRequest` asks for, comparable across a round trip. */
const summaryOf = (exerciseRequest: ExerciseRequest.Type): readonly unknown[] => [
  ExerciseConcept.idOf(ExerciseRequest.exerciseOf(exerciseRequest)),
  Load.valueOf(ExerciseRequest.loadOf(exerciseRequest)),
  Load.unitOf(ExerciseRequest.loadOf(exerciseRequest)),
  ExerciseRequest.setsOf(exerciseRequest),
  ExerciseRequest.repsOf(exerciseRequest),
]

describe('ExerciseRequest.make', () => {
  it('should write the StrongLifts squat as an active routine plan ServiceRequest, 5×5 at the bar', () => {
    // Act
    const wire = Schema.encodeSync(WireExerciseRequest)(squatAt(45))

    // Assert
    expect(wire).toMatchObject({
      id: 'sr-2',
      status: 'active',
      intent: 'plan',
      priority: 'routine',
      category: [{ coding: [{ code: 'strength-training' }] }],
      code: { text: 'Squat', coding: [{ code: 'squat', display: 'Squat' }] },
      subject: { reference: 'Patient/p-1' },
      instantiatesCanonical: [plan.url],
      authoredOn: '2026-01-05T18:00:00.000Z',
    })
    expect(wire.replaces ?? []).toEqual([])
    expect(
      wire.orderDetail?.map((detail) => [
        detail.coding?.[0]?.code,
        detail.extension?.[0]?.url,
        detail.extension?.[0]?.valueInteger ?? quantityFields(detail.extension?.[0]?.valueQuantity),
      ])
    ).toEqual([
      [
        LiftingMeasureCode.Load,
        WildflowerExtension.LiftingMeasureValue,
        { value: 45, unit: 'lb', system: 'http://unitsofmeasure.org', code: '[lb_av]' },
      ],
      [LiftingMeasureCode.Sets, WildflowerExtension.LiftingMeasureValue, 5],
      [LiftingMeasureCode.Reps, WildflowerExtension.LiftingMeasureValue, 5],
    ])
  })

  it("should take the plan's sets and reps for the exercise, at the given load, and read them back through the wire", () => {
    fc.assert(
      fc.property(plannedExerciseRequestArb, ({ planned, exerciseRequest }) => {
        const read = throughWire(WireExerciseRequest, exerciseRequest)
        expect(summaryOf(read)).toEqual(summaryOf(exerciseRequest))
        expect([ExerciseRequest.setsOf(read), ExerciseRequest.repsOf(read)]).toEqual([
          PlannedExercise.setsOf(planned),
          PlannedExercise.repsOf(planned),
        ])
        expect(ExerciseRequest.planUrlOf(read)).toBe(ExerciseRequest.planUrlOf(exerciseRequest))
        expect(read.id).toBe(exerciseRequest.id)
      }),
      { numRuns: WIRE_RUNS }
    )
  })

  it('should refuse an exercise the plan does not run, naming it', () => {
    fc.assert(
      fc.property(planArb, exerciseIdArb, (anyPlan, exerciseId) => {
        fc.pre(Option.isNone(Plan.plannedExerciseOf(anyPlan, exerciseId)))
        const refused = Either.flip(
          ExerciseRequest.make({
            serviceRequestId: 'sr-1',
            subject: SUBJECT,
            plan: anyPlan,
            exerciseId,
            load: made(Load.make({ value: 0, unit: 'lb' })),
            authoredOn: AUTHORED_ON,
          })
        )
        expect(Either.map(refused, (error) => error.message)).toEqual(
          Either.right(`the plan does not run the exercise ${JSON.stringify(exerciseId)}`)
        )
      }),
      { numRuns: RUNS }
    )
  })

  it("should refuse a load under the floor in the rule's unit, and a load in the other unit", () => {
    const make = (value: number, unit: Load.Unit): Either.Either<unknown, unknown> =>
      ExerciseRequest.make({
        serviceRequestId: 'sr-1',
        subject: SUBJECT,
        plan,
        exerciseId: 'squat',
        load: made(Load.make({ value, unit })),
        authoredOn: AUTHORED_ON,
      })
    const messageOf = (made_: Either.Either<unknown, unknown>): string =>
      Either.match(made_, {
        onLeft: (error) => (error instanceof Error ? error.message : ''),
        onRight: () => '',
      })
    expect(messageOf(make(40, 'lb'))).toContain('expected a load of at least 45 lb')
    expect(messageOf(make(20, 'kg'))).toContain('expected a load in lb')
  })
})

describe('ExerciseRequest.Schema', () => {
  it('should refuse a `ServiceRequest` with no id, or without a single plan url, naming each', () => {
    fc.assert(
      fc.property(
        exerciseRequestArb,
        fc.boolean(),
        fc.constantFrom('one' as const, 'none' as const, 'two' as const),
        (exerciseRequest, idless, urls) => {
          const [url] = exerciseRequest.instantiatesCanonical
          const edited = {
            ...exerciseRequest,
            id: idless ? null : exerciseRequest.id,
            instantiatesCanonical: { one: [url], none: [], two: [url, url] }[urls],
          }
          expect(fieldsOf(decode(edited))).toEqual([
            ...(idless ? ['id'] : []),
            ...(urls === 'one' ? [] : ['instantiatesCanonical']),
          ])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse a missing or doubled measure, naming the order details', () => {
    fc.assert(
      fc.property(
        exerciseRequestArb,
        fc.integer({ min: 0, max: 2 }),
        fc.boolean(),
        (exerciseRequest, index, doubled) => {
          const { orderDetail } = exerciseRequest
          const edited = {
            ...exerciseRequest,
            orderDetail: doubled
              ? [...orderDetail, ...orderDetail.slice(index, index + 1)]
              : orderDetail.filter((_, at) => at !== index),
          }
          expect(issuePathsOf(decode(edited))).toEqual(['orderDetail'])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse a load with a comparator, in a unit it does not write, or negative, naming where', () => {
    fc.assert(
      fc.property(
        exerciseRequestArb,
        fc.constantFrom('comparator' as const, 'code' as const, 'value' as const),
        (exerciseRequest, field) => {
          // Arrange: the writer emits the load first, with its value extension.
          const [load, ...rest] = exerciseRequest.orderDetail
          const [valueExtension] = load?.extension ?? []
          if (load === undefined || valueExtension === undefined)
            throw new Error('the writer emits the load first, with its value extension')
          const quantity = ExerciseRequest.loadOf(exerciseRequest)
          const mutated = {
            comparator: { ...quantity, comparator: '<' as const },
            code: { ...quantity, code: Code.make('st') },
            value: { ...quantity, value: -1 - quantity.value },
          }[field]
          const edited = {
            ...exerciseRequest,
            orderDetail: [
              { ...load, extension: [{ ...valueExtension, valueQuantity: mutated }] },
              ...rest,
            ],
          }

          // Act / Assert
          expect(issuePathsOf(decode(edited))).toEqual([
            `orderDetail.0.extension.0.valueQuantity.${field}`,
          ])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should name zero sets or negative reps where they are', () => {
    fc.assert(
      fc.property(
        exerciseRequestArb,
        fc.constantFrom('sets' as const, 'reps' as const),
        (exerciseRequest, measure) => {
          // Arrange: the sets and reps are order details 1 and 2.
          const index = measure === 'sets' ? 1 : 2
          const edited = {
            ...exerciseRequest,
            orderDetail: exerciseRequest.orderDetail.map((detail, at) =>
              at === index
                ? {
                    ...detail,
                    extension: detail.extension.map((extension) => ({
                      ...extension,
                      valueInteger: measure === 'sets' ? 0 : -3,
                    })),
                  }
                : detail
            ),
          }

          // Act / Assert
          expect(issuePathsOf(decode(edited))).toEqual([
            `orderDetail.${index}.extension.0.valueInteger`,
          ])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should ignore order details that measure something foreign', () => {
    fc.assert(
      fc.property(
        exerciseRequestArb,
        fc.array(Arbitrary.make(CodeableConcept.Schema), { maxLength: 3 }),
        (exerciseRequest, foreign) => {
          const padded = {
            ...exerciseRequest,
            orderDetail: [...exerciseRequest.orderDetail, ...foreign],
          }
          expect(Either.map(decode(padded), summaryOf)).toEqual(
            Either.right(summaryOf(exerciseRequest))
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse a foreign `ServiceRequest`, naming every field it lacks', () => {
    fc.assert(
      fc.property(Arbitrary.make(CodeableConcept.Schema), (code) => {
        const foreign = Schema.decodeUnknownSync(ServiceRequest.Schema)({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          subject: { reference: 'Patient/p-1' },
          code: Schema.encodeSync(CodeableConcept.Schema)(code),
        })
        expect(fieldsOf(decode(foreign))).toEqual(['id', 'code', 'instantiatesCanonical'])
      }),
      { numRuns: RUNS }
    )
  })
})

describe('ExerciseRequest.close / forExercise', () => {
  it('should change nothing but the status', () => {
    fc.assert(
      fc.property(
        exerciseRequestArb,
        fc.constantFrom('completed' as const, 'revoked' as const),
        (exerciseRequest, status) => {
          expect(ExerciseRequest.close(exerciseRequest, status)).toEqual({
            ...exerciseRequest,
            status,
          })
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should find the one `ExerciseRequest` at an exercise, and none when there are none or several', () => {
    const squat = squatAt(45)
    const deadlift = made(
      ExerciseRequest.make({
        serviceRequestId: 'sr-3',
        subject: SUBJECT,
        plan,
        exerciseId: 'deadlift',
        load: StrongLifts5x5.STARTING_LOADS.deadlift,
        authoredOn: AUTHORED_ON,
      })
    )
    expect(ExerciseRequest.forExercise([squat, deadlift], 'deadlift')).toEqual(
      Option.some(deadlift)
    )
    expect(ExerciseRequest.forExercise([squat, deadlift], 'bench-press')).toEqual(Option.none())
    expect(ExerciseRequest.forExercise([squat, deadlift, squat], 'squat')).toEqual(Option.none())
  })
})

describe('ExerciseRequest.isMetBy', () => {
  it('should be met by five fives, and not by a fourth set of four', () => {
    const squat = squatAt(135)
    const sessionOf = (reps: readonly number[]): Session.Type => {
      const [session] = Session.groupByDate(
        reps.map((setReps, index) =>
          setAt({
            exerciseRequest: squat,
            workoutLabel: 'A',
            start: DateTime.unsafeMake(Date.UTC(2026, 0, 5, 18, index * 3)),
            reps: setReps,
          })
        ),
        DateTime.zoneMakeOffset(0)
      )
      if (session === undefined) throw new Error('one session')
      return session
    }
    expect(ExerciseRequest.isMetBy(squat, sessionOf([5, 5, 5, 5, 5]))).toBe(true)
    expect(ExerciseRequest.isMetBy(squat, sessionOf([5, 5, 5, 4, 5]))).toBe(false)
  })

  it('should be met exactly when every set it asks for reached the reps it asks for', () => {
    fc.assert(
      fc.property(
        exerciseRequestArb.chain((exerciseRequest) =>
          fc.tuple(
            fc.constant(exerciseRequest),
            fc.oneof(
              successfulRepsArb(exerciseRequest).map((reps) => [true, reps] as const),
              failedRepsArb(exerciseRequest).map((reps) => [false, reps] as const)
            )
          )
        ),
        ([exerciseRequest, [expected, reps]]) => {
          const [session] = Session.groupByDate(
            reps.map((setReps, index) =>
              setAt({
                exerciseRequest,
                workoutLabel: 'A',
                start: DateTime.unsafeMake(Date.UTC(2026, 0, 5, 18, index * 3)),
                reps: setReps,
              })
            ),
            DateTime.zoneMakeOffset(0)
          )
          if (session === undefined) throw new Error('one session')
          expect(ExerciseRequest.isMetBy(exerciseRequest, session)).toBe(expected)
        }
      ),
      { numRuns: RUNS }
    )
  })
})

// Helpers

/** The top-level fields the issues of a refused decode are under, each once, in order. */
function fieldsOf(result: Either.Either<unknown, ParseResult.ParseError>): readonly string[] {
  return Arr.dedupe(issuePathsOf(result).map((path) => path.split('.')[0] ?? ''))
}

/** The four fields of an encoded quantity a load is made of, without the empty element slots. */
function quantityFields(quantity: unknown): {
  readonly value: number | null
  readonly unit: string | null
  readonly system: string | null
  readonly code: string | null
} {
  const { value, unit, system, code } = Schema.decodeUnknownSync(Quantity.Schema)(quantity)
  return { value, unit, system, code }
}
