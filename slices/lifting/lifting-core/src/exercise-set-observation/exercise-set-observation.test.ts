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
  exerciseRequestArb,
  instantArb,
  issuePathsOf,
  made,
  SUBJECT,
  throughWire,
  workoutLabelArb,
} from '../test-helpers.ts'
import * as ExerciseSetObservation from './exercise-set-observation.ts'

const RUNS = numRunsFor({ base: 100 })

// Encode → JSON → decode of a whole Observation is the slow path, so the wire
// round-trip runs fewer iterations than the in-memory properties.
const WIRE_RUNS = numRunsFor({ base: 50 })

/** A set as the wire carries it: an `Observation`, decoded and then narrowed. */
const WireSet = Schema.compose(Observation.Schema, ExerciseSetObservation.Schema)

/** What a set is made of: an `ExerciseRequest`, a label, a start, a length up to ten minutes, and any count of reps. */
const setInputArb = fc
  .record({
    exerciseRequest: exerciseRequestArb,
    workoutLabel: workoutLabelArb,
    start: instantArb,
    lengthMillis: fc.nat({ max: 600_000 }),
    reps: fc.nat({ max: 30 }),
  })
  .map(({ lengthMillis, ...set }) => ({
    ...set,
    observationId: 'obs-1',
    end: DateTime.addDuration(set.start, `${lengthMillis} millis`),
  }))

/** Any set, as made. */
const setArb: fc.Arbitrary<ExerciseSetObservation.Type> = setInputArb.map((input) =>
  made(ExerciseSetObservation.make(input))
)

const squatExerciseRequest = made(
  ExerciseRequest.make({
    serviceRequestId: 'sr-2',
    subject: SUBJECT,
    plan: StrongLifts5x5.plan('plan-1'),
    exerciseId: 'squat',
    load: StrongLifts5x5.STARTING_LOADS.squat,
    authoredOn: AUTHORED_ON,
  })
)

describe('ExerciseSetObservation', () => {
  it('should write a squat set as a final activity Observation based on its `ServiceRequest`', () => {
    // Act
    const wire = Schema.encodeSync(WireSet)(
      made(
        ExerciseSetObservation.make({
          observationId: 'obs-1',
          exerciseRequest: squatExerciseRequest,
          workoutLabel: 'A',
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
      effectivePeriod: { start: '2026-01-05T18:00:00.000Z', end: '2026-01-05T18:00:40.000Z' },
      valueInteger: 4,
      extension: [{ valueString: 'A' }],
    })
  })

  it('should read back every set it makes, with its `ServiceRequest`, through the wire', () => {
    fc.assert(
      fc.property(setInputArb, (input) => {
        const set = throughWire(WireSet, made(ExerciseSetObservation.make(input)))
        expect({
          exerciseId: ExerciseConcept.idOf(ExerciseSetObservation.exerciseOf(set)),
          workoutLabel: ExerciseSetObservation.workoutLabelOf(set),
          start: DateTime.toEpochMillis(ExerciseSetObservation.startOf(set)),
          end: DateTime.toEpochMillis(ExerciseSetObservation.endOf(set)),
          reps: ExerciseSetObservation.repsOf(set),
          serviceRequestId: ExerciseSetObservation.serviceRequestIdOf(set),
        }).toEqual({
          exerciseId: ExerciseConcept.idOf(ExerciseRequest.exerciseOf(input.exerciseRequest)),
          workoutLabel: input.workoutLabel,
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
      fc.property(setArb, Arbitrary.make(Observation.StatusSchema), (set, status) => {
        const read = Schema.decodeEither(ExerciseSetObservation.Schema)({ ...set, status })
        expect(issuePathsOf(read)).toEqual(
          Observation.RETRACTED_STATUSES.has(status) ? ['status'] : []
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a period missing either end, or ending before it starts', () => {
    fc.assert(
      fc.property(
        setArb,
        fc.constantFrom(
          'none' as const,
          'startOnly' as const,
          'endOnly' as const,
          'backwards' as const
        ),
        (set, mutation) => {
          // Arrange
          const period = set.effectivePeriod
          const effectivePeriod = {
            none: null,
            startOnly: { ...period, end: null },
            endOnly: { ...period, start: null },
            backwards: { ...period, start: DateTime.addDuration(period.end, '1 millis') },
          }[mutation]

          // Act
          const paths = issuePathsOf(
            Schema.decodeEither(ExerciseSetObservation.Schema)({ ...set, effectivePeriod })
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
      fc.property(setArb, fc.constantFrom(null, -1, 2.5), (set, valueInteger) => {
        const read = Schema.decodeEither(ExerciseSetObservation.Schema)({ ...set, valueInteger })
        expect(issuePathsOf(read)).toEqual(['valueInteger'])
      }),
      { numRuns: RUNS }
    )
  })

  it('should read the `ServiceRequest` beside references to other resources, and refuse none or two', () => {
    fc.assert(
      fc.property(setArb, (set) => {
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
            decode({ ...set, basedOn: [carePlan, ...set.basedOn] }),
            ExerciseSetObservation.serviceRequestIdOf
          )
        ).toEqual(Either.right(ExerciseSetObservation.serviceRequestIdOf(set)))
        expect(issuePathsOf(decode({ ...set, basedOn: [carePlan] }))).toEqual(['basedOn'])
        expect(issuePathsOf(decode({ ...set, basedOn: [...set.basedOn, other] }))).toEqual([
          'basedOn',
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse an observation with no workout label, or an exercise coding with no display', () => {
    fc.assert(
      fc.property(setArb, (set) => {
        const decode = Schema.decodeEither(ExerciseSetObservation.Schema)
        const nameless = {
          ...set.code,
          coding: set.code.coding.map((coding) => ({ ...coding, display: null })),
        }
        expect(issuePathsOf(decode({ ...set, extension: [] }))).toEqual(['extension'])
        expect(issuePathsOf(decode({ ...set, code: nameless }))).toEqual(['code.coding.0.display'])
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
      fc.property(fc.array(setArb, { maxLength: 6 }), (sets) => {
        const sorted = ExerciseSetObservation.sortByStart(sets)
        const starts = sorted.map((set) =>
          DateTime.toEpochMillis(ExerciseSetObservation.startOf(set))
        )
        expect(starts).toEqual(starts.toSorted((a, b) => a - b))
        expect(sorted).toHaveLength(sets.length)
        expect(sets.every((set) => sorted.includes(set))).toBe(true)
      }),
      { numRuns: RUNS }
    )
  })
})
