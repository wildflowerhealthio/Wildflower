import { DateTime, Either, Option } from 'effect'
import * as fc from 'fast-check'

import {
  type Exercise,
  type LoadUnit,
  makePlan,
  type Plan,
  type PlanInput,
  type PlannedExercise,
  type ProgressionRule,
} from './plan.ts'
import type { Prescription } from './prescription.ts'
import type { ProgressionDecision } from './progression.ts'
import type { SetResult } from './set-result.ts'

/** A string with something other than whitespace in it. */
const nonBlankStringArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1 })
  .filter((text) => text.trim().length > 0)

/** An exercise slug, e.g. `bench-press`. */
const exerciseIdArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-z]{1,8}(-[a-z]{1,8}){0,2}$/)

/** An exercise with a slug id and a non-empty display name. */
const exerciseArb: fc.Arbitrary<Exercise> = fc.record({
  id: exerciseIdArb,
  name: nonBlankStringArb,
})

/** Either load unit. */
const loadUnitArb: fc.Arbitrary<LoadUnit> = fc.constantFrom('lb', 'kg')

/** A finite, non-negative amount of load, fractional as well as whole. */
const amountArb: fc.Arbitrary<number> = fc.oneof(
  fc.nat({ max: 400 }).map((plates) => plates * 2.5),
  fc.double({ min: 0, max: 1000, noNaN: true })
)

/** A progression rule within the ranges `makePlan` accepts. */
const progressionArb: fc.Arbitrary<ProgressionRule> = fc.record({
  unit: loadUnitArb,
  increment: fc.oneof(fc.constantFrom(2.5, 5, 10), fc.double({ min: 0.5, max: 50, noNaN: true })),
  failuresBeforeDeload: fc.integer({ min: 1, max: 5 }),
  // At least 1%: a smaller fraction of a light load is below floating-point
  // rounding, and no real program deloads by less.
  deloadFraction: fc.oneof(
    fc.constantFrom(0.1, 0.2, 0.5),
    fc.double({ min: 0.01, max: 0.99, noNaN: true })
  ),
  minimumLoad: fc.oneof(fc.constantFrom(0, 20, 45), amountArb),
  loadStep: fc.oneof(fc.constantFrom(1, 2.5, 5), fc.double({ min: 0.5, max: 20, noNaN: true })),
})

/** A valid planned exercise for `exercise`. */
const plannedForArb = (exercise: Exercise): fc.Arbitrary<PlannedExercise> =>
  fc.record({
    exercise: fc.constant(exercise),
    sets: fc.integer({ min: 1, max: 10 }),
    reps: fc.integer({ min: 1, max: 20 }),
    progression: progressionArb,
  })

/** A valid planned exercise. */
const plannedArb: fc.Arbitrary<PlannedExercise> = exerciseArb.chain(plannedForArb)

/** An instant with millisecond precision, the precision a FHIR `dateTime` keeps. */
const instantArb: fc.Arbitrary<DateTime.Utc> = fc
  .integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) })
  .map((epochMillis) => DateTime.unsafeMake(epochMillis))

/** A fixed-offset time zone, whole hours from UTC−12 to UTC+14. */
const zoneArb: fc.Arbitrary<DateTime.TimeZone> = fc
  .integer({ min: -12, max: 14 })
  .map((hours) => DateTime.zoneMakeOffset(hours * 3_600_000))

/** The UTC zone. */
const UTC: DateTime.TimeZone = DateTime.zoneMakeOffset(0)

/** A workout label, e.g. `A` or `B2`. */
const workoutLabelArb: fc.Arbitrary<string> = fc.stringMatching(/^[A-Z][0-9]?$/)

/** Caps on a generated plan's size, for properties whose cost grows with it. */
interface PlanSize {
  readonly maxExercises?: number
  readonly maxWorkouts?: number
}

/**
 * A valid plan input: one entry per distinct exercise, and workouts over those
 * exercises, every exercise run by at least one workout.
 */
const planInputOfSizeArb = (size: PlanSize = {}): fc.Arbitrary<PlanInput> =>
  fc
    .uniqueArray(exerciseArb, {
      minLength: 1,
      maxLength: size.maxExercises,
      selector: (exercise) => exercise.id,
    })
    .chain((exercises) =>
      fc.record({
        title: nonBlankStringArb,
        exercises: fc.tuple(...exercises.map(plannedForArb)),
        workouts: fc
          .uniqueArray(workoutLabelArb, { minLength: 1, maxLength: size.maxWorkouts })
          .chain((labels) =>
            fc.tuple(
              ...labels.map((label) =>
                fc
                  .array(fc.constantFrom(...exercises.map((exercise) => exercise.id)), {
                    minLength: 1,
                  })
                  .map((exerciseIds) => ({ label, exerciseIds }))
              )
            )
          )
          // An exercise no workout drew goes to one of them, round-robin, so
          // every planned exercise is run.
          .map((workouts) => {
            const unused = exercises
              .map((exercise) => exercise.id)
              .filter((id) => !workouts.some((workout) => workout.exerciseIds.includes(id)))
            return workouts.map((workout, index) => ({
              ...workout,
              exerciseIds: [
                ...workout.exerciseIds,
                ...unused.filter((_, at) => at % workouts.length === index),
              ],
            }))
          }),
      })
    )

/** A valid plan input of any size. */
const planInputArb: fc.Arbitrary<PlanInput> = planInputOfSizeArb()

/**
 * A valid plan, built through `makePlan`. The input is valid by
 * construction, so a refusal is a bug in the arbitrary and fails loudly.
 */
const planArb: fc.Arbitrary<Plan> = planInputArb.map((input) =>
  Either.getOrThrowWith(makePlan(input), (invalid) => invalid)
)

/**
 * A valid plan of at most three exercises and two workouts, for the wire
 * round-trip: its cost grows with every action encoded and decoded, and a
 * bigger plan exercises no path a small one misses — the in-memory properties
 * cover plan size.
 */
const smallPlanArb: fc.Arbitrary<Plan> = planInputOfSizeArb({
  maxExercises: 3,
  maxWorkouts: 2,
}).map((input) => Either.getOrThrowWith(makePlan(input), (invalid) => invalid))

/** The prescription `planned` makes at a load of `value` in the rule's unit. */
const prescriptionAt = (planned: PlannedExercise, value: number): Prescription => ({
  exercise: planned.exercise,
  load: { value, unit: planned.progression.unit },
  sets: planned.sets,
  reps: planned.reps,
})

/** A planned exercise and a prescription it makes, the load at least `above` over the rule's floor. */
interface Prescribed {
  readonly planned: PlannedExercise
  readonly prescription: Prescription
}

/** A prescription in range for its planned exercise, its load at least `above` over the floor. */
const prescribedForArb = (planned: PlannedExercise, above = 0): fc.Arbitrary<Prescribed> =>
  fc
    .oneof(
      fc.constant(above),
      amountArb.map((amount) => amount + above)
    )
    .map((extra) => ({
      planned,
      prescription: prescriptionAt(planned, planned.progression.minimumLoad + extra),
    }))

/** A planned exercise and a prescription in range for it. */
const prescribedArb: fc.Arbitrary<Prescribed> = plannedArb.chain((planned) =>
  prescribedForArb(planned)
)

/** Any prescription, in range, at either unit. */
const prescriptionArb: fc.Arbitrary<Prescription> = prescribedArb.map(
  ({ prescription }) => prescription
)

/** Milliseconds one generated set takes, start to end. */
const SET_LENGTH_MS = 60_000

/** Milliseconds between the starts of consecutive sets of one session. */
const SET_GAP_MS = 180_000

/** A set of `reps` at `prescription`'s exercise, starting at `start` and lasting {@link SET_LENGTH_MS}. */
const setAt = (
  prescription: Prescription,
  workoutLabel: string,
  start: DateTime.Utc,
  reps: number
): SetResult => ({
  exercise: prescription.exercise,
  workoutLabel,
  start,
  end: DateTime.addDuration(start, `${SET_LENGTH_MS} millis`),
  reps,
})

/** The 18:00 UTC instant of the `index`th session day of a generated history, one day apart. */
const sessionAt = (index: number): DateTime.Utc =>
  DateTime.unsafeMake(Date.UTC(2026, 0, 1, 18) + index * 86_400_000)

/** The sets of one session on session day `index`: one set per entry of `reps`, {@link SET_GAP_MS} apart. */
const sessionSets = (
  prescription: Prescription,
  index: number,
  reps: readonly number[]
): readonly SetResult[] =>
  reps.map((setReps, setIndex) =>
    setAt(
      prescription,
      index % 2 === 0 ? 'A' : 'B',
      DateTime.addDuration(sessionAt(index), `${setIndex * SET_GAP_MS} millis`),
      setReps
    )
  )

/** Reps per set that meet `prescription`, with any extra sets after. */
const successfulRepsArb = (prescription: Prescription): fc.Arbitrary<readonly number[]> =>
  fc
    .tuple(
      fc.array(fc.integer({ min: prescription.reps, max: prescription.reps + 5 }), {
        minLength: prescription.sets,
        maxLength: prescription.sets,
      }),
      fc.array(fc.nat({ max: prescription.reps + 5 }), { maxLength: 2 })
    )
    .map(([prescribed, extra]) => [...prescribed, ...extra])

/**
 * Reps per set that fall short of `prescription`: a set short, or a set too
 * few — but never no set at all, since a session is its sets.
 */
const failedRepsArb = (prescription: Prescription): fc.Arbitrary<readonly number[]> => {
  const setShort = fc
    .tuple(successfulRepsArb(prescription), fc.nat(), fc.nat({ max: prescription.reps - 1 }))
    .map(([reps, index, shortBy]) =>
      reps.map((setReps, setIndex) =>
        setIndex === index % prescription.sets
          ? prescription.reps - 1 - (shortBy % prescription.reps)
          : setReps
      )
    )
  return prescription.sets === 1
    ? setShort
    : fc.oneof(
        fc.array(fc.nat({ max: prescription.reps + 5 }), {
          minLength: 1,
          maxLength: prescription.sets - 1,
        }),
        setShort
      )
}

/** A prescription, the sets logged against it, and the decision they call for. */
interface ProgressionCase {
  readonly expected: ProgressionDecision
  readonly planned: PlannedExercise
  readonly prescription: Prescription
  readonly sets: readonly SetResult[]
  /** The trailing failed sessions the history ends with. */
  readonly trailingFailures: number
}

/**
 * A history of sessions — a prior stretch succeeding or failing, then `tail`
 * — as sets, session `i` on day {@link sessionAt}`(i)`, so the tail is always
 * the most recent.
 */
const caseFrom = (
  expected: ProgressionDecision,
  prescribed: Prescribed,
  tail: fc.Arbitrary<readonly (readonly number[])[]>,
  trailingFailures: (tailLength: number) => number
): fc.Arbitrary<ProgressionCase> =>
  fc
    .tuple(
      fc.array(
        fc.oneof(successfulRepsArb(prescribed.prescription), failedRepsArb(prescribed.prescription))
      ),
      tail
    )
    .map(([prior, sessions]) => ({
      expected,
      planned: prescribed.planned,
      prescription: prescribed.prescription,
      sets: [...prior, ...sessions].flatMap((reps, index) =>
        sessionSets(prescribed.prescription, index, reps)
      ),
      trailingFailures: trailingFailures(sessions.length),
    }))

/** The latest session met the prescription. */
const incrementCaseArb: fc.Arbitrary<ProgressionCase> = prescribedArb.chain((prescribed) =>
  caseFrom(
    'increment',
    prescribed,
    successfulRepsArb(prescribed.prescription).map((reps) => [reps]),
    () => 0
  )
)

/** Enough trailing failures at a load with room above its floor. */
const deloadCaseArb: fc.Arbitrary<ProgressionCase> = plannedArb
  .chain((planned) => prescribedForArb(planned, 1))
  .chain((prescribed) =>
    caseFrom(
      'deload',
      prescribed,
      fc.array(failedRepsArb(prescribed.prescription), {
        minLength: prescribed.planned.progression.failuresBeforeDeload,
        maxLength: prescribed.planned.progression.failuresBeforeDeload + 2,
      }),
      (count) => count
    )
  )

/**
 * Too few trailing failures: a met session, then fewer failures than a deload
 * waits for — which needs a rule that waits for at least two.
 */
const fewFailuresCaseArb: fc.Arbitrary<ProgressionCase> = plannedArb
  .map((planned) => ({
    ...planned,
    progression: {
      ...planned.progression,
      failuresBeforeDeload: Math.max(2, planned.progression.failuresBeforeDeload),
    },
  }))
  .chain((planned) => prescribedForArb(planned))
  .chain((prescribed) =>
    caseFrom(
      'hold',
      prescribed,
      fc
        .tuple(
          successfulRepsArb(prescribed.prescription),
          fc.array(failedRepsArb(prescribed.prescription), {
            minLength: 1,
            maxLength: prescribed.planned.progression.failuresBeforeDeload - 1,
          })
        )
        .map(([met, failures]) => [met, ...failures]),
      (count) => count - 1
    )
  )

/** Enough trailing failures, but the load is already at its floor. */
const atFloorCaseArb: fc.Arbitrary<ProgressionCase> = plannedArb
  .map((planned) => ({
    planned,
    prescription: prescriptionAt(planned, planned.progression.minimumLoad),
  }))
  .chain((prescribed) =>
    caseFrom(
      'hold',
      prescribed,
      fc.array(failedRepsArb(prescribed.prescription), {
        minLength: prescribed.planned.progression.failuresBeforeDeload,
        maxLength: prescribed.planned.progression.failuresBeforeDeload + 2,
      }),
      (count) => count
    )
  )

/** Never attempted: no sets at all. */
const unattemptedCaseArb: fc.Arbitrary<ProgressionCase> = prescribedArb.map(
  ({ planned, prescription }) => ({
    expected: 'hold' as const,
    planned,
    prescription,
    sets: [],
    trailingFailures: 0,
  })
)

/** A history from any of the classes. */
const progressionCaseArb: fc.Arbitrary<ProgressionCase> = fc.oneof(
  incrementCaseArb,
  deloadCaseArb,
  fewFailuresCaseArb,
  atFloorCaseArb,
  unattemptedCaseArb
)

/** The value of an `Option`, or a test failure when it holds none. */
const someOrFail = <A>(option: Option.Option<A>): A =>
  Option.getOrThrowWith(option, () => new Error('expected Some, got None'))

export {
  amountArb,
  atFloorCaseArb,
  deloadCaseArb,
  exerciseArb,
  exerciseIdArb,
  failedRepsArb,
  fewFailuresCaseArb,
  incrementCaseArb,
  instantArb,
  loadUnitArb,
  nonBlankStringArb,
  planArb,
  planInputArb,
  plannedArb,
  prescribedArb,
  prescriptionArb,
  prescriptionAt,
  progressionCaseArb,
  sessionAt,
  sessionSets,
  setAt,
  smallPlanArb,
  someOrFail,
  successfulRepsArb,
  unattemptedCaseArb,
  UTC,
  workoutLabelArb,
  zoneArb,
}
export type { Prescribed, ProgressionCase }
