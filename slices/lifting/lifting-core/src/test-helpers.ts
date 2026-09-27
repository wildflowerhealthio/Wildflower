import { Array as Arr, DateTime, Either } from 'effect'
import * as fc from 'fast-check'

import type { ExerciseAttempt } from './attempt.ts'
import {
  type Exercise,
  type ExerciseGoal,
  makePlan,
  type Plan,
  type PlanInput,
  type ProgressionRule,
} from './plan.ts'
import type { ProgressionDecision } from './progression.ts'

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

/** A finite, non-negative number of pounds, fractional as well as whole. */
const poundsArb: fc.Arbitrary<number> = fc.oneof(
  fc.nat({ max: 400 }).map((plates) => plates * 2.5),
  fc.double({ min: 0, max: 1000, noNaN: true })
)

/** A progression rule within the ranges `makePlan` accepts. */
const progressionArb: fc.Arbitrary<ProgressionRule> = fc.record({
  incrementLb: fc.oneof(fc.constantFrom(2.5, 5, 10), fc.double({ min: 0.5, max: 50, noNaN: true })),
  failuresBeforeDeload: fc.integer({ min: 1, max: 5 }),
  // At least 1%: a smaller fraction of a light load is below floating-point
  // rounding, and no real program deloads by less.
  deloadFraction: fc.oneof(
    fc.constantFrom(0.1, 0.2, 0.5),
    fc.double({ min: 0.01, max: 0.99, noNaN: true })
  ),
  minimumLoadLb: fc.oneof(fc.constantFrom(0, 45), poundsArb),
  loadStepLb: fc.oneof(fc.constantFrom(1, 2.5, 5), fc.double({ min: 0.5, max: 20, noNaN: true })),
})

/** A valid goal for the exercise, its load at least its floor (`above` pounds above, at least). */
const goalForArb = (exercise: Exercise, above = 0): fc.Arbitrary<ExerciseGoal> =>
  fc
    .record({
      progression: progressionArb,
      extraLb: fc.oneof(
        fc.constant(above),
        poundsArb.map((pounds) => pounds + above)
      ),
      sets: fc.integer({ min: 1, max: 10 }),
      reps: fc.integer({ min: 1, max: 20 }),
    })
    .map(({ progression, extraLb, sets, reps }) => ({
      exercise,
      loadLb: progression.minimumLoadLb + extraLb,
      sets,
      reps,
      progression,
    }))

/** A valid goal. */
const goalArb: fc.Arbitrary<ExerciseGoal> = exerciseArb.chain((exercise) => goalForArb(exercise))

/** An instant with millisecond precision, the precision a FHIR `dateTime` keeps. */
const instantArb: fc.Arbitrary<DateTime.Utc> = fc
  .integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) })
  .map((epochMillis) => DateTime.unsafeMake(epochMillis))

/** A workout label, e.g. `A` or `B2`. */
const workoutLabelArb: fc.Arbitrary<string> = fc.stringMatching(/^[A-Z][0-9]?$/)

/** Caps on a generated plan's size, for properties whose cost grows with it. */
interface PlanSize {
  readonly maxExercises?: number
  readonly maxWorkouts?: number
}

/** A valid plan input: one goal per distinct exercise, and workouts over those exercises. */
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
        goals: fc.tuple(...exercises.map((exercise) => goalForArb(exercise))),
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
          ),
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
 * round-trip: its cost grows with every `Goal` encoded and decoded, and a
 * bigger plan exercises no path a small one misses — the in-memory properties
 * cover plan size.
 */
const smallPlanArb: fc.Arbitrary<Plan> = planInputOfSizeArb({
  maxExercises: 3,
  maxWorkouts: 2,
}).map((input) => Either.getOrThrowWith(makePlan(input), (invalid) => invalid))

/** One attempt at `goal`'s prescription, at `loadLb`, with the given reps per set. */
const attemptAt = (
  goal: ExerciseGoal,
  performedAt: DateTime.Utc,
  loadLb: number,
  repsCompleted: readonly number[]
): ExerciseAttempt => ({
  exercise: goal.exercise,
  workoutLabel: 'A',
  performedAt,
  loadLb,
  prescribedSets: goal.sets,
  prescribedReps: goal.reps,
  repsCompleted,
})

/** Reps per set that meet `goal`'s prescription, with any extra sets after. */
const successfulRepsArb = (goal: ExerciseGoal): fc.Arbitrary<readonly number[]> =>
  fc
    .tuple(
      fc.array(fc.integer({ min: goal.reps, max: goal.reps + 5 }), {
        minLength: goal.sets,
        maxLength: goal.sets,
      }),
      fc.array(fc.nat({ max: goal.reps + 5 }), { maxLength: 2 })
    )
    .map(([prescribed, extra]) => [...prescribed, ...extra])

/** Reps per set that fall short of `goal`'s prescription: a set short, or a set too few. */
const failedRepsArb = (goal: ExerciseGoal): fc.Arbitrary<readonly number[]> =>
  fc.oneof(
    fc.array(fc.nat({ max: goal.reps + 5 }), { maxLength: goal.sets - 1 }),
    fc
      .tuple(successfulRepsArb(goal), fc.nat(), fc.nat({ max: goal.reps - 1 }))
      .map(([reps, index, shortBy]) =>
        Arr.replace(reps, index % goal.sets, goal.reps - 1 - (shortBy % goal.reps))
      )
  )

/** Milliseconds between consecutive generated sessions. */
const SESSION_GAP_MS = 60_000

/**
 * Attempts at `goal` at any of a few loads, succeeding or failing — the prior
 * history a decision must look past. Session `i` is at {@link sessionAt}`(i)`,
 * so a tail appended after it is always more recent.
 */
const priorHistoryArb = (goal: ExerciseGoal): fc.Arbitrary<readonly ExerciseAttempt[]> =>
  fc
    .array(
      fc.tuple(
        fc.constantFrom(goal.loadLb, goal.loadLb + goal.progression.loadStepLb, goal.loadLb / 2),
        fc.oneof(successfulRepsArb(goal), failedRepsArb(goal))
      )
    )
    .map((sessions) =>
      sessions.map(([loadLb, reps], index) => attemptAt(goal, sessionAt(index), loadLb, reps))
    )

/** The instant of the `index`th session of a generated history. */
const sessionAt = (index: number): DateTime.Utc =>
  DateTime.unsafeMake(Date.UTC(2026, 0, 1) + index * SESSION_GAP_MS)

/** Attempts at another exercise, at any instant — noise every decision must ignore. */
const otherExerciseNoiseArb = (goal: ExerciseGoal): fc.Arbitrary<readonly ExerciseAttempt[]> =>
  fc.array(
    fc.record({
      exercise: fc.constant({ id: `${goal.exercise.id}-other`, name: 'Other' }),
      workoutLabel: workoutLabelArb,
      performedAt: instantArb,
      loadLb: fc.constant(goal.loadLb),
      prescribedSets: fc.constant(goal.sets),
      prescribedReps: fc.constant(goal.reps),
      repsCompleted: fc.array(fc.nat({ max: goal.reps + 5 })),
    })
  )

/** A goal, a history, and the decision that history's class calls for. */
interface ProgressionCase {
  readonly expected: ProgressionDecision
  readonly goal: ExerciseGoal
  readonly attempts: readonly ExerciseAttempt[]
  /** The trailing failures at the goal's load the history ends with. */
  readonly trailingFailures: number
}

/** A prior history, then `tail` (each tail entry a load and its reps), then shuffled-in noise. */
const caseFrom = (
  expected: ProgressionDecision,
  goal: ExerciseGoal,
  tail: fc.Arbitrary<readonly (readonly [number, readonly number[]])[]>,
  trailingFailures: (tailLength: number) => number
): fc.Arbitrary<ProgressionCase> =>
  fc
    .tuple(priorHistoryArb(goal), tail, otherExerciseNoiseArb(goal))
    .map(([prior, sessions, noise]) => ({
      expected,
      goal,
      attempts: [
        ...prior,
        ...sessions.map(([loadLb, reps], index) =>
          attemptAt(goal, sessionAt(prior.length + index), loadLb, reps)
        ),
        ...noise,
      ],
      trailingFailures: trailingFailures(sessions.length),
    }))

/** The latest attempt was at the goal's load and succeeded. */
const incrementCaseArb: fc.Arbitrary<ProgressionCase> = goalArb.chain((goal) =>
  caseFrom(
    'increment',
    goal,
    successfulRepsArb(goal).map((reps) => [[goal.loadLb, reps] as const]),
    () => 0
  )
)

/** Enough trailing failures at a load with room above its floor. */
const deloadCaseArb: fc.Arbitrary<ProgressionCase> = exerciseArb
  .chain((exercise) => goalForArb(exercise, 1))
  .chain((goal) =>
    caseFrom(
      'deload',
      goal,
      fc.array(
        failedRepsArb(goal).map((reps) => [goal.loadLb, reps] as const),
        {
          minLength: goal.progression.failuresBeforeDeload,
          maxLength: goal.progression.failuresBeforeDeload + 2,
        }
      ),
      (count) => count
    )
  )

/**
 * Too few trailing failures: a session at another load, then fewer failures
 * at the goal's load than a deload waits for.
 */
const fewFailuresCaseArb: fc.Arbitrary<ProgressionCase> = goalArb.chain((goal) =>
  caseFrom(
    'hold',
    goal,
    fc
      .tuple(
        fc.oneof(successfulRepsArb(goal), failedRepsArb(goal)),
        fc.array(failedRepsArb(goal), { maxLength: goal.progression.failuresBeforeDeload - 1 })
      )
      .map(([otherLoadReps, failures]) => [
        [goal.loadLb + goal.progression.loadStepLb, otherLoadReps] as const,
        ...failures.map((reps) => [goal.loadLb, reps] as const),
      ]),
    (count) => count - 1
  )
)

/** Enough trailing failures, but the load is already at its floor. */
const atFloorCaseArb: fc.Arbitrary<ProgressionCase> = goalArb
  .map((goal) => ({ ...goal, loadLb: goal.progression.minimumLoadLb }))
  .chain((goal) =>
    caseFrom(
      'hold',
      goal,
      fc.array(
        failedRepsArb(goal).map((reps) => [goal.loadLb, reps] as const),
        {
          minLength: goal.progression.failuresBeforeDeload,
          maxLength: goal.progression.failuresBeforeDeload + 2,
        }
      ),
      (count) => count
    )
  )

/** Never attempted: only other exercises' noise. */
const unattemptedCaseArb: fc.Arbitrary<ProgressionCase> = goalArb.chain((goal) =>
  otherExerciseNoiseArb(goal).map((noise) => ({
    expected: 'hold' as const,
    goal,
    attempts: noise,
    trailingFailures: 0,
  }))
)

/** A history from any of the classes. */
const progressionCaseArb: fc.Arbitrary<ProgressionCase> = fc.oneof(
  incrementCaseArb,
  deloadCaseArb,
  fewFailuresCaseArb,
  atFloorCaseArb,
  unattemptedCaseArb
)

export {
  atFloorCaseArb,
  attemptAt,
  deloadCaseArb,
  exerciseArb,
  exerciseIdArb,
  failedRepsArb,
  fewFailuresCaseArb,
  goalArb,
  goalForArb,
  incrementCaseArb,
  instantArb,
  nonBlankStringArb,
  planArb,
  planInputArb,
  poundsArb,
  progressionCaseArb,
  smallPlanArb,
  sessionAt,
  successfulRepsArb,
  unattemptedCaseArb,
  workoutLabelArb,
}
export type { ProgressionCase }
