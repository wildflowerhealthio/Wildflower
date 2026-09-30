import { Array as Arr, Data, Either, Option, pipe, Record } from 'effect'

import { describeProblem, type Exercise, type Load, type LoadUnit, type Plan } from './plan.ts'

/**
 * What a lifter is to do at one exercise until it moves: lift `load` for
 * `sets` × `reps`. One prescription is one load — a success or a deload
 * closes it and issues the next at the new load.
 *
 * @remarks
 * A prescription carries no rule: how its load moves is the plan's, on the
 * {@link Plan}'s `PlannedExercise` for the same exercise, and
 * `progressPrescription` takes both.
 */
interface Prescription {
  /** The exercise prescribed. */
  readonly exercise: Exercise
  /** The load to lift; finite and `≥ 0`. */
  readonly load: Load
  /** Sets to perform each session; a positive integer. */
  readonly sets: number
  /** Reps per set; a positive integer. */
  readonly reps: number
}

/** A field of a {@link Prescription} that can be out of range. */
type PrescriptionField = 'load' | 'sets' | 'reps'

/** One reason a prescription could not be made or read. */
type PrescriptionProblem = Data.TaggedEnum<{
  /** The plan does not run the exercise, so nothing says how to prescribe it. */
  ExerciseUnplanned: { readonly exerciseId: string }
  /** The load is in a unit the exercise's rule does not move. */
  LoadUnitMismatch: { readonly expected: LoadUnit; readonly given: LoadUnit }
  /** The load is under the rule's `minimumLoad`. */
  LoadBelowMinimum: { readonly minimumLoad: number; readonly unit: LoadUnit }
  /** `load` is not finite and non-negative, or `sets` / `reps` is not a positive integer. */
  PrescriptionOutOfRange: { readonly field: PrescriptionField }
}>

/** Constructors and matchers for {@link PrescriptionProblem}. */
const PrescriptionProblem = Data.taggedEnum<PrescriptionProblem>()

/** The one {@link PrescriptionProblem} a prescription read on its own can report. */
type PrescriptionOutOfRange = Data.TaggedEnum.Value<PrescriptionProblem, 'PrescriptionOutOfRange'>

/** {@link prescribe} refused, listing every problem it found. */
class PrescriptionRefused extends Data.TaggedError('PrescriptionRefused')<{
  /** Every reason the prescription was refused. */
  readonly problems: Arr.NonEmptyReadonlyArray<PrescriptionProblem>
}> {
  override get message(): string {
    return `prescription refused: ${this.problems.map(describeProblem).join('; ')}`
  }
}

/** An integer `> 0`. */
const isPositiveInt = (value: number): boolean => Number.isInteger(value) && value > 0

/**
 * The fields of a prescription that are out of range: `load.value` finite and
 * non-negative; `sets` and `reps` positive integers.
 *
 * @returns The out-of-range fields; empty when the prescription is in range
 */
const outOfRangePrescriptionFieldsOf = (
  prescription: Prescription
): readonly PrescriptionField[] => {
  const checks: readonly (readonly [PrescriptionField, boolean])[] = [
    ['load', Number.isFinite(prescription.load.value) && prescription.load.value >= 0],
    ['sets', isPositiveInt(prescription.sets)],
    ['reps', isPositiveInt(prescription.reps)],
  ]
  return checks.filter(([, valid]) => !valid).map(([field]) => field)
}

/**
 * The prescription a plan makes for one exercise at a load: the plan's sets ×
 * reps for that exercise, at `load`.
 *
 * @param plan - The plan that runs the exercise
 * @param exerciseId - The exercise, by id, among `plan.exercisesById`
 * @param load - The load to prescribe, in the unit the exercise's rule moves
 * @returns The prescription; or {@link PrescriptionRefused} listing every
 *   problem: the exercise unplanned, the load in another unit than the rule's,
 *   the load under the rule's `minimumLoad`, or the load not finite and
 *   non-negative
 *
 * @remarks
 * This is how a prescription is first made — a lifter's starting load — and
 * how one is re-made after a plan edit. Between sessions, `progressPrescription`
 * moves a prescription by its rule and needs no plan lookup.
 */
const prescribe = (
  plan: Plan,
  exerciseId: string,
  load: Load
): Either.Either<Prescription, PrescriptionRefused> =>
  pipe(
    Record.get(plan.exercisesById, exerciseId),
    Either.fromOption(() =>
      Arr.of<PrescriptionProblem>(PrescriptionProblem.ExerciseUnplanned({ exerciseId }))
    ),
    Either.flatMap((planned) => {
      const { progression } = planned
      const prescription: Prescription = {
        exercise: planned.exercise,
        load,
        sets: planned.sets,
        reps: planned.reps,
      }
      const problems: readonly PrescriptionProblem[] = [
        ...(load.unit === progression.unit
          ? []
          : [
              PrescriptionProblem.LoadUnitMismatch({
                expected: progression.unit,
                given: load.unit,
              }),
            ]),
        // A floor in another unit says nothing about this load, so only a load
        // in the rule's unit is held to it.
        ...(load.unit === progression.unit &&
        Number.isFinite(load.value) &&
        load.value < progression.minimumLoad
          ? [
              PrescriptionProblem.LoadBelowMinimum({
                minimumLoad: progression.minimumLoad,
                unit: progression.unit,
              }),
            ]
          : []),
        ...outOfRangePrescriptionFieldsOf(prescription).map((field) =>
          PrescriptionProblem.PrescriptionOutOfRange({ field })
        ),
      ]
      return Arr.match(problems, {
        onEmpty: () => Either.right(prescription),
        onNonEmpty: (found) => Either.left(found),
      })
    }),
    Either.mapLeft((problems) => new PrescriptionRefused({ problems }))
  )

/** The prescription at a new load value, everything else unchanged. */
const atLoad = (prescription: Prescription, value: number): Prescription => ({
  ...prescription,
  load: { value, unit: prescription.load.unit },
})

/** Whether two prescriptions prescribe the same thing. */
const samePrescription = (left: Prescription, right: Prescription): boolean =>
  left.exercise.id === right.exercise.id &&
  left.exercise.name === right.exercise.name &&
  left.load.value === right.load.value &&
  left.load.unit === right.load.unit &&
  left.sets === right.sets &&
  left.reps === right.reps

/** The prescription among several for `exerciseId`, when there is exactly one. */
const prescriptionFor = (
  prescriptions: readonly Prescription[],
  exerciseId: string
): Option.Option<Prescription> => {
  const matching = prescriptions.filter((prescription) => prescription.exercise.id === exerciseId)
  return matching.length === 1 ? Arr.head(matching) : Option.none()
}

export {
  atLoad,
  outOfRangePrescriptionFieldsOf,
  prescribe,
  prescriptionFor,
  PrescriptionProblem,
  PrescriptionRefused,
  samePrescription,
}
export type { Prescription, PrescriptionField, PrescriptionOutOfRange }
