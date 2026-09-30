import { Either, Option, Record } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { Load } from './plan.ts'
import {
  outOfRangePrescriptionFieldsOf,
  prescribe,
  type Prescription,
  type PrescriptionField,
  type PrescriptionProblem,
  prescriptionFor,
} from './prescription.ts'
import { strongLifts5x5 } from './strong-lifts.ts'
import { amountArb, exerciseIdArb, planArb, prescriptionArb } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

/** One way to push each field out of range, keeping the others valid. */
const breakField: {
  readonly [Field in PrescriptionField]: (prescription: Prescription) => Prescription
} = {
  load: (prescription) => ({ ...prescription, load: { ...prescription.load, value: -1 } }),
  sets: (prescription) => ({ ...prescription, sets: 0 }),
  reps: (prescription) => ({ ...prescription, reps: 2.5 }),
}
const FIELDS = Record.keys(breakField)

describe('prescribe', () => {
  it('should prescribe the StrongLifts squat as 5×5 at the bar', () => {
    expect(prescribe(strongLifts5x5(), 'squat', { value: 45, unit: 'lb' })).toEqual(
      Either.right({
        exercise: { id: 'squat', name: 'Squat' },
        load: { value: 45, unit: 'lb' },
        sets: 5,
        reps: 5,
      })
    )
  })

  it('should refuse a kilogram load for a plan whose rule is in pounds', () => {
    expect(problemsOf(prescribe(strongLifts5x5(), 'squat', { value: 20, unit: 'kg' }))).toEqual([
      { _tag: 'LoadUnitMismatch', expected: 'lb', given: 'kg' },
    ])
  })

  it("should take the plan's sets and reps for the exercise, at the given load", () => {
    fc.assert(
      fc.property(planArb, fc.nat(), amountArb, (plan, seed, extra) => {
        // Arrange
        const planned = Record.values(plan.exercisesById)[seed % Record.size(plan.exercisesById)]
        fc.pre(planned !== undefined)
        const load: Load = {
          value: planned.progression.minimumLoad + extra,
          unit: planned.progression.unit,
        }

        // Act / Assert
        expect(prescribe(plan, planned.exercise.id, load)).toEqual(
          Either.right({
            exercise: planned.exercise,
            load,
            sets: planned.sets,
            reps: planned.reps,
          })
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse an exercise the plan does not run', () => {
    fc.assert(
      fc.property(planArb, exerciseIdArb, amountArb, (plan, exerciseId, value) => {
        fc.pre(!Record.has(plan.exercisesById, exerciseId))
        expect(problemsOf(prescribe(plan, exerciseId, { value, unit: 'lb' }))).toEqual([
          { _tag: 'ExerciseUnplanned', exerciseId },
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it("should refuse a load under the floor in the rule's unit, and only the unit when it is another", () => {
    fc.assert(
      fc.property(planArb, fc.nat(), fc.boolean(), (plan, seed, wrongUnit) => {
        // Arrange
        const planned = Record.values(plan.exercisesById)[seed % Record.size(plan.exercisesById)]
        fc.pre(planned !== undefined && planned.progression.minimumLoad > 0)
        const { unit, minimumLoad } = planned.progression
        const otherUnit = unit === 'lb' ? 'kg' : 'lb'
        const load: Load = { value: minimumLoad / 2, unit: wrongUnit ? otherUnit : unit }

        // Act
        const problems = problemsOf(prescribe(plan, planned.exercise.id, load))

        // Assert: a floor in another unit says nothing about the load given.
        expect(problems).toEqual(
          wrongUnit
            ? [{ _tag: 'LoadUnitMismatch', expected: unit, given: load.unit }]
            : [{ _tag: 'LoadBelowMinimum', minimumLoad, unit }]
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a load that is not a finite non-negative number', () => {
    fc.assert(
      fc.property(
        planArb,
        fc.nat(),
        fc.constantFrom(-1, Number.NaN, Number.POSITIVE_INFINITY),
        (plan, seed, value) => {
          const planned = Record.values(plan.exercisesById)[seed % Record.size(plan.exercisesById)]
          fc.pre(planned !== undefined)
          const problems = problemsOf(
            prescribe(plan, planned.exercise.id, { value, unit: planned.progression.unit })
          )
          expect(problems).toContainEqual({ _tag: 'PrescriptionOutOfRange', field: 'load' })
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should name its problems in the error message', () => {
    fc.assert(
      fc.property(planArb, exerciseIdArb, (plan, exerciseId) => {
        fc.pre(!Record.has(plan.exercisesById, exerciseId))
        const refused = Either.flip(prescribe(plan, exerciseId, { value: 0, unit: 'lb' }))
        expect(Either.map(refused, (error) => error.message)).toEqual(
          Either.right(`prescription refused: ExerciseUnplanned {"exerciseId":"${exerciseId}"}`)
        )
      }),
      { numRuns: RUNS }
    )
  })
})

describe('outOfRangePrescriptionFieldsOf', () => {
  it('should find nothing wrong with a prescription in range', () => {
    fc.assert(
      fc.property(prescriptionArb, (prescription) => {
        expect(outOfRangePrescriptionFieldsOf(prescription)).toEqual([])
      }),
      { numRuns: RUNS }
    )
  })

  it('should name exactly the field that was pushed out of range', () => {
    fc.assert(
      fc.property(prescriptionArb, fc.constantFrom(...FIELDS), (prescription, field) => {
        expect(outOfRangePrescriptionFieldsOf(breakField[field](prescription))).toEqual([field])
      }),
      { numRuns: RUNS }
    )
  })
})

describe('prescriptionFor', () => {
  it('should find the one prescription at an exercise, and none when there are none or several', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(prescriptionArb, { selector: (prescription) => prescription.exercise.id }),
        fc.nat(),
        (prescriptions, seed) => {
          const [first] = prescriptions
          fc.pre(first !== undefined)
          const picked = prescriptions[seed % prescriptions.length] ?? first
          expect(prescriptionFor(prescriptions, picked.exercise.id)).toEqual(Option.some(picked))
          expect(prescriptionFor(prescriptions, `${picked.exercise.id}-other`)._tag).toBe('None')
          expect(prescriptionFor([...prescriptions, picked], picked.exercise.id)._tag).toBe('None')
        }
      ),
      { numRuns: RUNS }
    )
  })
})

// Helpers

function problemsOf(
  made: Either.Either<Prescription, { readonly problems: readonly PrescriptionProblem[] }>
): readonly PrescriptionProblem[] {
  return Either.match(made, { onLeft: (refused) => refused.problems, onRight: () => [] })
}
