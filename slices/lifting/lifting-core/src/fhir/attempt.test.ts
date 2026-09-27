import { Arbitrary, DateTime, Either, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { Quantity } from 'fhir-r4/data-types'
import { Observation } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { attemptSucceeded, type ExerciseAttempt } from '../attempt.ts'
import { exerciseArb, instantArb, poundsArb, workoutLabelArb } from '../test-helpers.ts'
import { attemptFromFhir, attemptToFhir, type ObservationResource } from './attempt.ts'
import { LiftingMeasureCode } from './elements.ts'
import { foreignConceptArb, problemsOf, throughWire } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

// Encode → JSON → decode of a whole Observation is the slow path, so the wire
// round-trip runs fewer iterations than the in-memory properties.
const WIRE_RUNS = numRunsFor({ base: 50 })

const options = {
  observationId: 'obs-1',
  subject: 'Patient/p-1',
  goalId: 'goal-squat',
  carePlanId: 'plan-1',
}

/** Any attempt: reps completed are any counts, not only near the prescription. */
const attemptArb: fc.Arbitrary<ExerciseAttempt> = fc.record({
  exercise: exerciseArb,
  workoutLabel: workoutLabelArb,
  performedAt: instantArb,
  loadLb: poundsArb,
  prescribedSets: fc.integer({ min: 1, max: 10 }),
  prescribedReps: fc.integer({ min: 1, max: 20 }),
  repsCompleted: fc.array(fc.nat({ max: 30 })),
})

const statusArb = Arbitrary.make(Observation.StatusSchema)

/** A decoded Observation carrying nothing lifting-specific, for generated fields to be spread onto. */
const shell: ObservationResource = Schema.decodeUnknownSync(Observation.Schema)({
  resourceType: 'Observation',
  status: 'final',
  code: { text: 'Heart rate' },
})

describe('attemptToFhir / attemptFromFhir', () => {
  it('should write a squat session as a final activity Observation focused on its goal', () => {
    // Arrange
    const attempt: ExerciseAttempt = {
      exercise: { id: 'squat', name: 'Squat' },
      workoutLabel: 'A',
      performedAt: DateTime.unsafeMake('2026-01-05T18:00:00Z'),
      loadLb: 135,
      prescribedSets: 5,
      prescribedReps: 5,
      repsCompleted: [5, 5, 5, 4, 3],
    }

    // Act
    const wire = Schema.encodeSync(Observation.Schema)(attemptToFhir(attempt, options))

    // Assert
    expect(wire.status).toBe('final')
    expect(wire.category).toMatchObject([
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/observation-category',
            code: 'activity',
          },
        ],
      },
    ])
    expect(wire.code.text).toBe('Squat')
    expect(wire.focus).toMatchObject([{ reference: 'Goal/goal-squat' }])
    expect(wire.basedOn).toMatchObject([{ reference: 'CarePlan/plan-1' }])
    expect(wire.effectiveDateTime).toBe('2026-01-05T18:00:00.000Z')
    expect(wire.valueBoolean).toBe(false)
    expect(
      wire.component?.map((component) => [
        component.code.coding?.[0]?.code,
        component.valueInteger ?? component.valueQuantity?.value,
      ])
    ).toEqual([
      [LiftingMeasureCode.LoadLb, 135],
      [LiftingMeasureCode.PrescribedSets, 5],
      [LiftingMeasureCode.PrescribedReps, 5],
      [LiftingMeasureCode.RepsCompleted, 5],
      [LiftingMeasureCode.RepsCompleted, 5],
      [LiftingMeasureCode.RepsCompleted, 5],
      [LiftingMeasureCode.RepsCompleted, 4],
      [LiftingMeasureCode.RepsCompleted, 3],
    ])
  })

  it('should read back every attempt it writes, through the encoded wire form', () => {
    fc.assert(
      fc.property(attemptArb, (attempt) => {
        // Act
        const read = attemptFromFhir(
          throughWire(Observation.Schema, attemptToFhir(attempt, options))
        )

        // Assert
        const readAttempt = Either.getOrThrow(read).pipe(Option.getOrThrow)
        expect(comparable(readAttempt)).toEqual(comparable(attempt))
        expect(DateTime.Equivalence(readAttempt.performedAt, attempt.performedAt)).toBe(true)
      }),
      { numRuns: WIRE_RUNS }
    )
  })

  it('should read nothing from a retracted observation, and the attempt from any other status', () => {
    fc.assert(
      fc.property(attemptArb, statusArb, fc.boolean(), (attempt, status, broken) => {
        // Arrange
        const written = attemptToFhir(attempt, options)
        const observation = { ...written, status, extension: broken ? [] : written.extension }

        // Act
        const read = attemptFromFhir(observation)

        // Assert
        if (Observation.RETRACTED_STATUSES.has(status))
          expect(read).toEqual(Either.right(Option.none()))
        else if (broken) expect(problemsOf(read)).toEqual([{ _tag: 'WorkoutLabelUnreadable' }])
        else
          expect(Either.map(read, Option.map(comparable))).toEqual(
            Either.right(Option.some(comparable(attempt)))
          )
      }),
      { numRuns: RUNS }
    )
  })

  it('should store the derived success as valueBoolean, and ignore it on read', () => {
    fc.assert(
      fc.property(attemptArb, (attempt) => {
        const written = attemptToFhir(attempt, options)
        expect(written.valueBoolean).toBe(attemptSucceeded(attempt))
        const lying = { ...written, valueBoolean: !attemptSucceeded(attempt) }
        expect(Either.map(attemptFromFhir(lying), Option.map(attemptSucceeded))).toEqual(
          Either.right(Option.some(attemptSucceeded(attempt)))
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse the whole attempt when any reps-completed component lacks a count', () => {
    fc.assert(
      fc.property(
        attemptArb.filter((attempt) => attempt.repsCompleted.length > 0),
        fc.nat(),
        fc.constantFrom(null, -1, -7),
        (attempt, seed, bad) => {
          // Arrange
          const written = attemptToFhir(attempt, options)
          const setIndex = seed % attempt.repsCompleted.length
          // The first three components are the load and the prescription.
          const componentIndex = 3 + setIndex
          const edited = {
            ...written,
            component: written.component.map((component, index) =>
              index === componentIndex ? { ...component, valueInteger: bad } : component
            ),
          }

          // Act / Assert
          expect(problemsOf(attemptFromFhir(edited))).toEqual([
            { _tag: 'RepsCompletedUnreadable', index: setIndex },
          ])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse an attempt missing its time, label, exercise name or a single prescription component', () => {
    fc.assert(
      fc.property(attemptArb, fc.integer({ min: 0, max: 2 }), (attempt, doubled) => {
        const written = attemptToFhir(attempt, options)
        const tagsOf = (observation: ObservationResource): readonly unknown[] =>
          problemsOf(attemptFromFhir(observation))
        expect(tagsOf({ ...written, effectiveDateTime: null })).toEqual([
          { _tag: 'PerformedAtMissing' },
        ])
        expect(
          tagsOf({ ...written, extension: [...written.extension, ...written.extension] })
        ).toEqual([{ _tag: 'WorkoutLabelUnreadable' }])
        expect(
          tagsOf({
            ...written,
            code: {
              ...written.code,
              coding: written.code.coding.map((coding) => ({ ...coding, display: null })),
            },
          })
        ).toEqual([{ _tag: 'ExerciseUnreadable' }])
        expect(
          tagsOf({
            ...written,
            component: [...written.component, ...written.component.slice(doubled, doubled + 1)],
          })
        ).toEqual([
          {
            _tag: 'MeasureUnreadable',
            measure: [
              LiftingMeasureCode.LoadLb,
              LiftingMeasureCode.PrescribedSets,
              LiftingMeasureCode.PrescribedReps,
            ][doubled],
          },
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a zero prescription, a negative load, or a load with a comparator', () => {
    fc.assert(
      fc.property(
        attemptArb,
        fc.constantFrom(
          'sets' as const,
          'reps' as const,
          'negative' as const,
          'comparator' as const
        ),
        (attempt, mutation) => {
          // Arrange: the load, sets and reps are components 0, 1 and 2.
          const written = attemptToFhir(attempt, options)
          const [load, sets, reps, ...completed] = written.component
          if (load === undefined || sets === undefined || reps === undefined)
            throw new Error('the writer emits the load and the prescription first')
          const mutations: Readonly<Record<typeof mutation, readonly (typeof load)[]>> = {
            sets: [load, { ...sets, valueInteger: 0 }, reps],
            reps: [load, sets, { ...reps, valueInteger: 0 }],
            negative: [
              { ...load, valueQuantity: { ...poundsOnly(load), value: -attempt.loadLb - 1 } },
              sets,
              reps,
            ],
            comparator: [
              { ...load, valueQuantity: { ...poundsOnly(load), comparator: '<' } },
              sets,
              reps,
            ],
          }
          const mutated = mutations[mutation]
          const measure = {
            sets: LiftingMeasureCode.PrescribedSets,
            reps: LiftingMeasureCode.PrescribedReps,
            negative: LiftingMeasureCode.LoadLb,
            comparator: LiftingMeasureCode.LoadLb,
          }[mutation]

          // Act / Assert
          expect(
            problemsOf(attemptFromFhir({ ...written, component: [...mutated, ...completed] }))
          ).toEqual([{ _tag: 'MeasureUnreadable', measure }])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should name its problems in the error message', () => {
    fc.assert(
      fc.property(attemptArb, (attempt) => {
        const written = attemptToFhir(attempt, options)
        const refused = Either.flip(attemptFromFhir({ ...written, effectiveDateTime: null }))
        expect(Either.map(refused, (unreadable) => unreadable.message)).toEqual(
          Either.right('attempt unreadable: PerformedAtMissing')
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should ignore components that measure something foreign', () => {
    fc.assert(
      fc.property(
        attemptArb,
        fc.array(fc.tuple(foreignConceptArb, fc.integer())),
        (attempt, foreign) => {
          const written = attemptToFhir(attempt, options)
          const [firstComponent] = written.component
          fc.pre(firstComponent !== undefined)
          const withForeign = {
            ...written,
            component: [
              ...written.component,
              ...foreign.map(([code, valueInteger]) => ({
                ...firstComponent,
                code,
                valueQuantity: null,
                valueInteger,
              })),
            ],
          }
          expect(Either.map(attemptFromFhir(withForeign), Option.map(comparable))).toEqual(
            Either.right(Option.some(comparable(attempt)))
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse a foreign observation, reporting every missing part, and never throw', () => {
    fc.assert(
      fc.property(foreignConceptArb, instantArb, (code, effectiveDateTime) => {
        const tags = problemsOf(attemptFromFhir({ ...shell, code, effectiveDateTime })).map(
          (problem) => problem._tag
        )
        expect(tags).toEqual([
          'ExerciseUnreadable',
          'WorkoutLabelUnreadable',
          'MeasureUnreadable',
          'MeasureUnreadable',
          'MeasureUnreadable',
        ])
      }),
      { numRuns: RUNS }
    )
  })
})

// Helpers

/** The load component's `[lb_av]` quantity, as the writer made it, re-typed from the `any` slot. */
function poundsOnly(component: ObservationResource['component'][number]): Quantity.Type {
  return Schema.decodeUnknownSync(Schema.typeSchema(Quantity.Schema))(component.valueQuantity)
}

/** An attempt with its instant as epoch millis, so equality does not depend on DateTime's cached fields. */
function comparable(attempt: ExerciseAttempt): Omit<ExerciseAttempt, 'performedAt'> & {
  readonly performedAt: number
} {
  return { ...attempt, performedAt: DateTime.toEpochMillis(attempt.performedAt) }
}
