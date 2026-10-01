/**
 * fast-check arbitraries and helpers that build lifting resources through
 * the `make`s, for this package's tests and, through the
 * `lifting-core/test-helpers` subpath, for its consumers' tests.
 *
 * @packageDocumentation
 */
import { Array as Arr, DateTime, Either, Option, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { IdentifierAndReference } from 'fhir-r4/data-types'

import * as ExerciseRequest from './exercise-request/exercise-request.ts'
import * as ExerciseSetObservation from './exercise-set-observation/exercise-set-observation.ts'
import * as ExerciseConcept from './exercise/exercise-concept.ts'
import * as Load from './load/load.ts'
import * as StrongLifts5x5 from './plans/strong-lifts.ts'
import * as TrainingPlanDefinition from './training-plan-definition/training-plan-definition.ts'
import * as WorkoutProcedure from './workout-procedure/workout-procedure.ts'

/** The value of a make a test built from valid inputs; a refusal is a bug in the test and fails loudly. */
const made = <A, E>(result: Either.Either<A, E>): A => Either.getOrThrowWith(result, (e) => e)

/**
 * Where the issues of a refused decode or make are, as dotted paths
 * (`orderDetail.0.extension`), each once; none when it was accepted.
 */
const issuePathsOf = <A>(result: Either.Either<A, ParseResult.ParseError>): readonly string[] =>
  Either.match(result, {
    onRight: () => [],
    onLeft: (error) =>
      Arr.dedupe(
        ParseResult.ArrayFormatter.formatErrorSync(error).map((issue) => issue.path.join('.'))
      ),
  })

/** The messages of the issues of a refused decode or make; none when it was accepted. */
const issueMessagesOf = <A>(result: Either.Either<A, ParseResult.ParseError>): readonly string[] =>
  Either.match(result, {
    onRight: () => [],
    onLeft: (error) =>
      ParseResult.ArrayFormatter.formatErrorSync(error).map((issue) => issue.message),
  })

/** A resource encoded to wire JSON and decoded back, as a server round-trip leaves it. */
const throughWire = <A, I>(schema: Schema.Schema<A, I>, resource: A): A =>
  Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(Schema.encodeSync(schema)(resource))))

/** The lifter every generated resource is about. */
const SUBJECT: IdentifierAndReference.ReferenceType = IdentifierAndReference.referenceTo({
  resourceType: 'Patient',
  id: 'p-1',
})

/** A non-empty string with no whitespace at either end. */
const nonEmptyTrimmedStringArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1 })
  .filter((text) => text.length > 0 && text.trim() === text)

/** An exercise slug, e.g. `bench-press`. */
const exerciseIdArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-z]{1,8}(-[a-z]{1,8}){0,2}$/)

/** An exercise with a slug id and a non-empty, trimmed display name. */
const exerciseConceptArb: fc.Arbitrary<ExerciseConcept.Type> = fc
  .record({ id: exerciseIdArb, name: nonEmptyTrimmedStringArb })
  .map((exercise) => made(ExerciseConcept.make(exercise)))

/** Either load unit. */
const loadUnitArb: fc.Arbitrary<Load.Unit> = fc.constantFrom('[lb_av]', 'kg')

/** A finite, non-negative amount of load, fractional as well as whole. */
const amountArb: fc.Arbitrary<number> = fc.oneof(
  fc.nat({ max: 400 }).map((plates) => plates * 2.5),
  fc.double({ min: 0, max: 1000, noNaN: true })
)

/** The parameters of a progression rule within the ranges `ProgressionRule.make` accepts. */
const progressionRuleInputArb = fc.record({
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

/** A progression rule within the ranges `ProgressionRule.make` accepts. */
const progressionRuleArb: fc.Arbitrary<TrainingPlanDefinition.ProgressionRule.Type> =
  progressionRuleInputArb.map((progressionRuleParameters) =>
    made(TrainingPlanDefinition.ProgressionRule.make(progressionRuleParameters))
  )

/** An exercise (definition) running `exerciseConcept`, in range. */
const trainingPlanDefinitionExerciseForArb = (
  exerciseConcept: ExerciseConcept.Type
): fc.Arbitrary<TrainingPlanDefinition.Exercise.Type> =>
  fc
    .record({
      sets: fc.integer({ min: 1, max: 10 }),
      reps: fc.integer({ min: 1, max: 20 }),
      progressionRule: progressionRuleArb,
    })
    .map((trainingPlanDefinitionExercise) =>
      made(
        TrainingPlanDefinition.Exercise.make({ exerciseConcept, ...trainingPlanDefinitionExercise })
      )
    )

/** An exercise (definition), in range. */
const trainingPlanDefinitionExerciseArb: fc.Arbitrary<TrainingPlanDefinition.Exercise.Type> =
  exerciseConceptArb.chain(trainingPlanDefinitionExerciseForArb)

/** An instant with millisecond precision, the precision a FHIR `dateTime` keeps. */
const instantArb: fc.Arbitrary<DateTime.Utc> = fc
  .integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) })
  .map((epochMillis) => DateTime.unsafeMake(epochMillis))

/** A day label, e.g. `A` or `B2`. */
const dayLabelArb: fc.Arbitrary<string> = fc.stringMatching(/^[A-Z][0-9]?$/)

/**
 * Caps on a generated training plan definition's size. Decoding one checks
 * every exercise (definition)'s rule extension on every day, so its cost
 * grows with its size; a bigger one exercises no path a small one misses.
 */
interface TrainingPlanDefinitionSize {
  readonly maxExercises: number
  readonly maxDays: number
}

/**
 * A valid training plan definition: distinct exercises, each defined once
 * and shared by every day that runs it, and days with distinct labels.
 */
const trainingPlanDefinitionOfSizeArb = (
  size: TrainingPlanDefinitionSize
): fc.Arbitrary<TrainingPlanDefinition.Type> =>
  fc
    .uniqueArray(exerciseConceptArb, {
      minLength: 1,
      maxLength: size.maxExercises,
      selector: ExerciseConcept.idOf,
    })
    .chain((exerciseConcepts) =>
      fc.record({
        title: nonEmptyTrimmedStringArb,
        distinctTrainingPlanDefinitionExercises: fc.tuple(
          ...exerciseConcepts.map(trainingPlanDefinitionExerciseForArb)
        ),
        labels: fc.uniqueArray(dayLabelArb, { minLength: 1, maxLength: size.maxDays }),
      })
    )
    .chain(({ title, distinctTrainingPlanDefinitionExercises, labels }) =>
      fc
        .tuple(
          ...labels.map((label) =>
            fc
              .array(fc.constantFrom(...distinctTrainingPlanDefinitionExercises), {
                minLength: 1,
                maxLength: size.maxExercises,
              })
              .map((trainingPlanDefinitionExercises) =>
                made(TrainingPlanDefinition.Day.make({ label, trainingPlanDefinitionExercises }))
              )
          )
        )
        .map((trainingPlanDefinitionDays) =>
          made(
            TrainingPlanDefinition.make({
              planDefinitionId: 'plan-1',
              title,
              trainingPlanDefinitionDays,
            })
          )
        )
    )

/** A valid training plan definition of up to four exercises and three days. */
const trainingPlanDefinitionArb: fc.Arbitrary<TrainingPlanDefinition.Type> =
  trainingPlanDefinitionOfSizeArb({ maxExercises: 4, maxDays: 3 })

/**
 * A valid training plan definition of at most three exercises and two days, for the wire
 * round-trip: its cost grows with every action encoded and decoded.
 */
const smallTrainingPlanDefinitionArb: fc.Arbitrary<TrainingPlanDefinition.Type> =
  trainingPlanDefinitionOfSizeArb({ maxExercises: 3, maxDays: 2 })

/** A one-day training plan definition running `trainingPlanDefinitionExercise`. */
const trainingPlanDefinitionRunning = (
  trainingPlanDefinitionExercise: TrainingPlanDefinition.Exercise.Type
): TrainingPlanDefinition.Type =>
  made(
    TrainingPlanDefinition.make({
      planDefinitionId: 'plan-1',
      title: 'Plan',
      trainingPlanDefinitionDays: [
        made(
          TrainingPlanDefinition.Day.make({
            label: 'A',
            trainingPlanDefinitionExercises: [trainingPlanDefinitionExercise],
          })
        ),
      ],
    })
  )

/** A starting load for each exercise `trainingPlanDefinition` runs: its rule's floor, in its rule's unit. */
const startingLoadsAtFloorOf = (
  trainingPlanDefinition: TrainingPlanDefinition.Type
): ExerciseRequest.StartingLoads =>
  Object.fromEntries(
    TrainingPlanDefinition.exercisesOf(trainingPlanDefinition).map(
      (trainingPlanDefinitionExercise) => {
        const progressionRule = TrainingPlanDefinition.Exercise.progressionRuleOf(
          trainingPlanDefinitionExercise
        )
        return [
          TrainingPlanDefinition.Exercise.exerciseIdOf(trainingPlanDefinitionExercise),
          made(
            Load.make({
              value: TrainingPlanDefinition.ProgressionRule.minimumLoadOf(progressionRule),
              unit: TrainingPlanDefinition.ProgressionRule.unitOf(progressionRule),
            })
          ),
        ]
      }
    )
  )

/** When every generated `ExerciseRequest` was issued. */
const AUTHORED_ON = DateTime.unsafeMake('2026-01-05T18:00:00Z')

/**
 * The `ExerciseRequest` for `trainingPlanDefinitionExercise`, stored as
 * `sr-1`, at a load of `value` in the rule's unit.
 */
const exerciseRequestAt = (
  trainingPlanDefinitionExercise: TrainingPlanDefinition.Exercise.Type,
  value: number
): ExerciseRequest.Type =>
  made(
    ExerciseRequest.make({
      serviceRequestId: 'sr-1',
      subject: SUBJECT,
      trainingPlanDefinition: trainingPlanDefinitionRunning(trainingPlanDefinitionExercise),
      exerciseId: TrainingPlanDefinition.Exercise.exerciseIdOf(trainingPlanDefinitionExercise),
      load: made(
        Load.make({
          value,
          unit: TrainingPlanDefinition.ProgressionRule.unitOf(
            TrainingPlanDefinition.Exercise.progressionRuleOf(trainingPlanDefinitionExercise)
          ),
        })
      ),
      authoredOn: AUTHORED_ON,
    })
  )

/** An exercise (definition) and an `ExerciseRequest` made from it. */
interface TrainingPlanDefinitionExerciseAndRequest {
  readonly trainingPlanDefinitionExercise: TrainingPlanDefinition.Exercise.Type
  readonly exerciseRequest: ExerciseRequest.Type
}

/**
 * An `ExerciseRequest` for `trainingPlanDefinitionExercise`, its load at
 * least `above` over the rule's floor.
 */
const trainingPlanDefinitionExerciseAndRequestForArb = (
  trainingPlanDefinitionExercise: TrainingPlanDefinition.Exercise.Type,
  above = 0
): fc.Arbitrary<TrainingPlanDefinitionExerciseAndRequest> =>
  fc
    .oneof(
      fc.constant(above),
      amountArb.map((amount) => amount + above)
    )
    .map((extra) => ({
      trainingPlanDefinitionExercise,
      exerciseRequest: exerciseRequestAt(
        trainingPlanDefinitionExercise,
        TrainingPlanDefinition.ProgressionRule.minimumLoadOf(
          TrainingPlanDefinition.Exercise.progressionRuleOf(trainingPlanDefinitionExercise)
        ) + extra
      ),
    }))

/** An exercise (definition) and an `ExerciseRequest` in range for it. */
const trainingPlanDefinitionExerciseAndRequestArb: fc.Arbitrary<TrainingPlanDefinitionExerciseAndRequest> =
  trainingPlanDefinitionExerciseArb.chain((trainingPlanDefinitionExercise) =>
    trainingPlanDefinitionExerciseAndRequestForArb(trainingPlanDefinitionExercise)
  )

/** Any `ExerciseRequest`, in range, at either unit. */
const exerciseRequestArb: fc.Arbitrary<ExerciseRequest.Type> =
  trainingPlanDefinitionExerciseAndRequestArb.map(({ exerciseRequest }) => exerciseRequest)

/** Milliseconds one generated set takes, start to end. */
const SET_LENGTH_MS = 60_000

/** Milliseconds between the starts of consecutive sets of one workout. */
const SET_GAP_MS = 180_000

/** Milliseconds one generated workout takes, start to end: long enough for twenty sets. */
const WORKOUT_LENGTH_MS = 20 * SET_GAP_MS

/**
 * The training plan definition generated workouts perform the days of:
 * StrongLifts' `A` and `B`, stored as `plan-1`.
 */
const WORKOUT_TRAINING_PLAN_DEFINITION: TrainingPlanDefinition.Type =
  StrongLifts5x5.trainingPlanDefinition('plan-1')

/** The 18:00 UTC instant the `index`th workout of a generated history starts at, one day apart. */
const workoutStartAt = (index: number): DateTime.Utc =>
  DateTime.unsafeMake(Date.UTC(2026, 0, 1, 18) + index * 86_400_000)

/**
 * The `index`th workout of a generated history, started but not yet
 * completed, carrying out `exerciseRequest`: `A` and `B` alternating,
 * starting at {@link workoutStartAt}`(index)`.
 */
const startedWorkoutAt = ({
  exerciseRequest,
  index,
}: {
  readonly exerciseRequest: ExerciseRequest.Type
  readonly index: number
}): WorkoutProcedure.Type =>
  made(
    WorkoutProcedure.make({
      procedureId: `workout-${index}`,
      subject: SUBJECT,
      trainingPlanDefinition: WORKOUT_TRAINING_PLAN_DEFINITION,
      trainingPlanDefinitionDay:
        TrainingPlanDefinition.daysOf(WORKOUT_TRAINING_PLAN_DEFINITION)[index % 2] ??
        Arr.headNonEmpty(TrainingPlanDefinition.daysOf(WORKOUT_TRAINING_PLAN_DEFINITION)),
      exerciseRequests: [exerciseRequest],
      start: workoutStartAt(index),
    })
  )

/**
 * The `index`th completed workout of a generated history, carrying out
 * `exerciseRequest`: `A` and `B` alternating, starting at
 * {@link workoutStartAt}`(index)` and lasting {@link WORKOUT_LENGTH_MS}.
 */
const completedWorkoutAt = ({
  exerciseRequest,
  index,
}: {
  readonly exerciseRequest: ExerciseRequest.Type
  readonly index: number
}): WorkoutProcedure.Type =>
  made(
    WorkoutProcedure.complete(
      startedWorkoutAt({ exerciseRequest, index }),
      DateTime.addDuration(workoutStartAt(index), `${WORKOUT_LENGTH_MS} millis`)
    )
  )

/** A set of `reps` against `exerciseRequest` in `workoutProcedure`, starting at `start` and lasting {@link SET_LENGTH_MS}. */
const exerciseSetObservationAt = ({
  exerciseRequest,
  workoutProcedure,
  start,
  reps,
}: {
  readonly exerciseRequest: ExerciseRequest.Type
  readonly workoutProcedure: WorkoutProcedure.Type
  readonly start: DateTime.Utc
  readonly reps: number
}): ExerciseSetObservation.Type =>
  made(
    ExerciseSetObservation.make({
      observationId: `set-${DateTime.toEpochMillis(start)}`,
      exerciseRequest,
      workoutProcedure,
      start,
      end: DateTime.addDuration(start, `${SET_LENGTH_MS} millis`),
      reps,
    })
  )

/** A completed workout and the sets logged in it. */
interface PerformedWorkout {
  readonly workoutProcedure: WorkoutProcedure.Type
  readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
}

/**
 * The `index`th completed workout of a generated history and its sets against
 * `exerciseRequest`: one set per entry of `reps`, {@link SET_GAP_MS} apart.
 */
const performedWorkoutAt = ({
  exerciseRequest,
  index,
  reps,
}: {
  readonly exerciseRequest: ExerciseRequest.Type
  readonly index: number
  readonly reps: readonly number[]
}): PerformedWorkout => {
  const workoutProcedure = completedWorkoutAt({ exerciseRequest, index })
  return {
    workoutProcedure,
    exerciseSetObservations: reps.map((setReps, setIndex) =>
      exerciseSetObservationAt({
        exerciseRequest,
        workoutProcedure,
        start: DateTime.addDuration(
          WorkoutProcedure.startOf(workoutProcedure),
          `${setIndex * SET_GAP_MS} millis`
        ),
        reps: setReps,
      })
    ),
  }
}

/** Reps per set that meet `exerciseRequest`, with any extra sets after. */
const successfulRepsArb = (
  exerciseRequest: ExerciseRequest.Type
): fc.Arbitrary<readonly number[]> => {
  const sets = ExerciseRequest.setsOf(exerciseRequest)
  const reps = ExerciseRequest.repsOf(exerciseRequest)
  return fc
    .tuple(
      fc.array(fc.integer({ min: reps, max: reps + 5 }), { minLength: sets, maxLength: sets }),
      fc.array(fc.nat({ max: reps + 5 }), { maxLength: 2 })
    )
    .map(([askedFor, extra]) => [...askedFor, ...extra])
}

/**
 * Reps per set that fall short of `exerciseRequest`: a set short, or a set too
 * few — but never no set at all, since a workout with no set of the exercise
 * is no attempt at it.
 */
const failedRepsArb = (exerciseRequest: ExerciseRequest.Type): fc.Arbitrary<readonly number[]> => {
  const sets = ExerciseRequest.setsOf(exerciseRequest)
  const reps = ExerciseRequest.repsOf(exerciseRequest)
  const setShort = fc
    .tuple(successfulRepsArb(exerciseRequest), fc.nat(), fc.nat({ max: reps - 1 }))
    .map(([performed, index, shortBy]) =>
      performed.map((setReps, setIndex) =>
        setIndex === index % sets ? reps - 1 - (shortBy % reps) : setReps
      )
    )
  return sets === 1
    ? setShort
    : fc.oneof(fc.array(fc.nat({ max: reps + 5 }), { minLength: 1, maxLength: sets - 1 }), setShort)
}

/** An `ExerciseRequest`, the workouts and sets performed against it, and the decision they call for. */
interface ProgressionCase {
  readonly expected: ExerciseRequest.Decision
  readonly trainingPlanDefinitionExercise: TrainingPlanDefinition.Exercise.Type
  readonly exerciseRequest: ExerciseRequest.Type
  readonly workoutProcedures: readonly WorkoutProcedure.Type[]
  readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
  /** The trailing failed workouts the history ends with. */
  readonly trailingFailures: number
}

/**
 * A history of workouts — a prior stretch succeeding or failing, then `tail`
 * — workout `i` starting at {@link workoutStartAt}`(i)`, so the tail is
 * always the most recent.
 */
const caseFrom = (spec: {
  readonly expected: ExerciseRequest.Decision
  readonly trainingPlanDefinitionExerciseAndRequest: TrainingPlanDefinitionExerciseAndRequest
  readonly tail: fc.Arbitrary<readonly (readonly number[])[]>
  readonly trailingFailures: (tailLength: number) => number
}): fc.Arbitrary<ProgressionCase> => {
  const { exerciseRequest, trainingPlanDefinitionExercise } =
    spec.trainingPlanDefinitionExerciseAndRequest
  return fc
    .tuple(
      fc.array(fc.oneof(successfulRepsArb(exerciseRequest), failedRepsArb(exerciseRequest)), {
        maxLength: 4,
      }),
      spec.tail
    )
    .map(([prior, tail]) => {
      const performed = [...prior, ...tail].map((reps, index) =>
        performedWorkoutAt({ exerciseRequest, index, reps })
      )
      return {
        expected: spec.expected,
        trainingPlanDefinitionExercise,
        exerciseRequest,
        workoutProcedures: performed.map(({ workoutProcedure }) => workoutProcedure),
        exerciseSetObservations: performed.flatMap(
          ({ exerciseSetObservations }) => exerciseSetObservations
        ),
        trailingFailures: spec.trailingFailures(tail.length),
      }
    })
}

/** The latest workout met the `ExerciseRequest`. */
const incrementCaseArb: fc.Arbitrary<ProgressionCase> =
  trainingPlanDefinitionExerciseAndRequestArb.chain((trainingPlanDefinitionExerciseAndRequest) =>
    caseFrom({
      expected: 'increment',
      trainingPlanDefinitionExerciseAndRequest,
      tail: successfulRepsArb(trainingPlanDefinitionExerciseAndRequest.exerciseRequest).map(
        (reps) => [reps]
      ),
      trailingFailures: () => 0,
    })
  )

/** Enough trailing failures at a load with room above its floor. */
const deloadCaseArb: fc.Arbitrary<ProgressionCase> = trainingPlanDefinitionExerciseArb
  .chain((trainingPlanDefinitionExercise) =>
    trainingPlanDefinitionExerciseAndRequestForArb(trainingPlanDefinitionExercise, 1)
  )
  .chain((trainingPlanDefinitionExerciseAndRequest) => {
    const failures = TrainingPlanDefinition.ProgressionRule.failuresBeforeDeloadOf(
      TrainingPlanDefinition.Exercise.progressionRuleOf(
        trainingPlanDefinitionExerciseAndRequest.trainingPlanDefinitionExercise
      )
    )
    return caseFrom({
      expected: 'deload',
      trainingPlanDefinitionExerciseAndRequest,
      tail: fc.array(failedRepsArb(trainingPlanDefinitionExerciseAndRequest.exerciseRequest), {
        minLength: failures,
        maxLength: failures + 2,
      }),
      trailingFailures: (count) => count,
    })
  })

/**
 * Too few trailing failures: a met workout, then fewer failures than a deload
 * waits for — which needs a rule that waits for at least two.
 */
const fewFailuresCaseArb: fc.Arbitrary<ProgressionCase> = fc
  .record({
    exerciseConcept: exerciseConceptArb,
    progressionRuleParameters: progressionRuleInputArb.map((progressionRuleParameters) => ({
      ...progressionRuleParameters,
      failuresBeforeDeload: Math.max(2, progressionRuleParameters.failuresBeforeDeload),
    })),
    sets: fc.integer({ min: 1, max: 10 }),
    reps: fc.integer({ min: 1, max: 20 }),
  })
  .map(({ exerciseConcept, progressionRuleParameters, sets, reps }) =>
    made(
      TrainingPlanDefinition.Exercise.make({
        exerciseConcept,
        sets,
        reps,
        progressionRule: made(
          TrainingPlanDefinition.ProgressionRule.make(progressionRuleParameters)
        ),
      })
    )
  )
  .chain((trainingPlanDefinitionExercise) =>
    trainingPlanDefinitionExerciseAndRequestForArb(trainingPlanDefinitionExercise)
  )
  .chain((trainingPlanDefinitionExerciseAndRequest) =>
    caseFrom({
      expected: 'hold',
      trainingPlanDefinitionExerciseAndRequest,
      tail: fc
        .tuple(
          successfulRepsArb(trainingPlanDefinitionExerciseAndRequest.exerciseRequest),
          fc.array(failedRepsArb(trainingPlanDefinitionExerciseAndRequest.exerciseRequest), {
            minLength: 1,
            maxLength:
              TrainingPlanDefinition.ProgressionRule.failuresBeforeDeloadOf(
                TrainingPlanDefinition.Exercise.progressionRuleOf(
                  trainingPlanDefinitionExerciseAndRequest.trainingPlanDefinitionExercise
                )
              ) - 1,
          })
        )
        .map(([met, failures]) => [met, ...failures]),
      trailingFailures: (count) => count - 1,
    })
  )

/** Enough trailing failures, but the load is already at its floor. */
const atFloorCaseArb: fc.Arbitrary<ProgressionCase> = trainingPlanDefinitionExerciseArb
  .map((trainingPlanDefinitionExercise) => ({
    trainingPlanDefinitionExercise,
    exerciseRequest: exerciseRequestAt(
      trainingPlanDefinitionExercise,
      TrainingPlanDefinition.ProgressionRule.minimumLoadOf(
        TrainingPlanDefinition.Exercise.progressionRuleOf(trainingPlanDefinitionExercise)
      )
    ),
  }))
  .chain((trainingPlanDefinitionExerciseAndRequest) => {
    const failures = TrainingPlanDefinition.ProgressionRule.failuresBeforeDeloadOf(
      TrainingPlanDefinition.Exercise.progressionRuleOf(
        trainingPlanDefinitionExerciseAndRequest.trainingPlanDefinitionExercise
      )
    )
    return caseFrom({
      expected: 'hold',
      trainingPlanDefinitionExerciseAndRequest,
      tail: fc.array(failedRepsArb(trainingPlanDefinitionExerciseAndRequest.exerciseRequest), {
        minLength: failures,
        maxLength: failures + 2,
      }),
      trailingFailures: (count) => count,
    })
  })

/** Never attempted: no sets at all. */
const unattemptedCaseArb: fc.Arbitrary<ProgressionCase> =
  trainingPlanDefinitionExerciseAndRequestArb.map(
    ({ trainingPlanDefinitionExercise, exerciseRequest }) => ({
      expected: 'hold' as const,
      trainingPlanDefinitionExercise,
      exerciseRequest,
      workoutProcedures: [],
      exerciseSetObservations: [],
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
  AUTHORED_ON,
  deloadCaseArb,
  exerciseConceptArb,
  exerciseIdArb,
  exerciseRequestArb,
  exerciseRequestAt,
  failedRepsArb,
  fewFailuresCaseArb,
  incrementCaseArb,
  instantArb,
  issueMessagesOf,
  issuePathsOf,
  loadUnitArb,
  made,
  nonEmptyTrimmedStringArb,
  trainingPlanDefinitionArb,
  trainingPlanDefinitionExerciseArb,
  progressionCaseArb,
  progressionRuleArb,
  progressionRuleInputArb,
  trainingPlanDefinitionExerciseAndRequestArb,
  completedWorkoutAt,
  performedWorkoutAt,
  exerciseSetObservationAt,
  smallTrainingPlanDefinitionArb,
  someOrFail,
  startedWorkoutAt,
  startingLoadsAtFloorOf,
  SUBJECT,
  successfulRepsArb,
  throughWire,
  dayLabelArb,
}
export type { PerformedWorkout, ProgressionCase, TrainingPlanDefinitionExerciseAndRequest }
