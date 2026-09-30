import { Array as Arr, DateTime, Either, Option, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { IdentifierAndReference } from 'fhir-r4/data-types'

import * as ExerciseRequest from './exercise-request/exercise-request.ts'
import * as ExerciseSetObservation from './exercise-set-observation/exercise-set-observation.ts'
import * as ExerciseConcept from './exercise/exercise-concept.ts'
import * as Load from './load/load.ts'
import * as Plan from './plan/plan.ts'
import * as PlannedExercise from './plan/planned-exercise.ts'
import * as ProgressionRule from './plan/progression-rule.ts'
import * as Workout from './plan/workout.ts'

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

/** A resource encoded to wire JSON and decoded back, as a server round-trip leaves it. */
const throughWire = <A, I>(schema: Schema.Schema<A, I>, resource: A): A =>
  Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(Schema.encodeSync(schema)(resource))))

/** The lifter every generated resource is about. */
const SUBJECT: IdentifierAndReference.ReferenceType = IdentifierAndReference.referenceTo({
  resourceType: 'Patient',
  id: 'p-1',
})

/** A string with something other than whitespace in it. */
const nonBlankStringArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1 })
  .filter((text) => text.trim().length > 0)

/** An exercise slug, e.g. `bench-press`. */
const exerciseIdArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-z]{1,8}(-[a-z]{1,8}){0,2}$/)

/** An exercise with a slug id and a non-blank display name. */
const exerciseArb: fc.Arbitrary<ExerciseConcept.Type> = fc
  .record({ id: exerciseIdArb, name: nonBlankStringArb })
  .map((exercise) => made(ExerciseConcept.make(exercise)))

/** Either load unit. */
const loadUnitArb: fc.Arbitrary<Load.Unit> = fc.constantFrom('lb', 'kg')

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
const progressionRuleArb: fc.Arbitrary<ProgressionRule.Type> = progressionRuleInputArb.map((rule) =>
  made(ProgressionRule.make(rule))
)

/** A planned exercise for `exercise`, in range. */
const plannedForArb = (exercise: ExerciseConcept.Type): fc.Arbitrary<PlannedExercise.Type> =>
  fc
    .record({
      sets: fc.integer({ min: 1, max: 10 }),
      reps: fc.integer({ min: 1, max: 20 }),
      progressionRule: progressionRuleArb,
    })
    .map((planned) => made(PlannedExercise.make({ exercise, ...planned })))

/** A planned exercise, in range. */
const plannedArb: fc.Arbitrary<PlannedExercise.Type> = exerciseArb.chain(plannedForArb)

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

/**
 * Caps on a generated plan's size. Decoding a plan checks every planned
 * exercise's rule extension in every workout, so its cost grows with the plan;
 * a bigger plan exercises no path a small one misses.
 */
interface PlanSize {
  readonly maxExercises: number
  readonly maxWorkouts: number
}

/**
 * A valid plan: distinct exercises, each planned once and shared by every
 * workout that runs it, and workouts with distinct labels.
 */
const planOfSizeArb = (size: PlanSize): fc.Arbitrary<Plan.Type> =>
  fc
    .uniqueArray(exerciseArb, {
      minLength: 1,
      maxLength: size.maxExercises,
      selector: ExerciseConcept.idOf,
    })
    .chain((exercises) =>
      fc.record({
        title: nonBlankStringArb,
        planned: fc.tuple(...exercises.map(plannedForArb)),
        labels: fc.uniqueArray(workoutLabelArb, { minLength: 1, maxLength: size.maxWorkouts }),
      })
    )
    .chain(({ title, planned, labels }) =>
      fc
        .tuple(
          ...labels.map((label) =>
            fc
              .array(fc.constantFrom(...planned), { minLength: 1, maxLength: size.maxExercises })
              .map((plannedExercises) => made(Workout.make({ label, plannedExercises })))
          )
        )
        .map((workouts) => made(Plan.make({ planDefinitionId: 'plan-1', title, workouts })))
    )

/** A valid plan of up to four exercises and three workouts. */
const planArb: fc.Arbitrary<Plan.Type> = planOfSizeArb({ maxExercises: 4, maxWorkouts: 3 })

/**
 * A valid plan of at most three exercises and two workouts, for the wire
 * round-trip: its cost grows with every action encoded and decoded.
 */
const smallPlanArb: fc.Arbitrary<Plan.Type> = planOfSizeArb({ maxExercises: 3, maxWorkouts: 2 })

/** A one-workout plan running `planned`. */
const planRunning = (planned: PlannedExercise.Type): Plan.Type =>
  made(
    Plan.make({
      planDefinitionId: 'plan-1',
      title: 'Plan',
      workouts: [made(Workout.make({ label: 'A', plannedExercises: [planned] }))],
    })
  )

/** When every generated `ExerciseRequest` was issued. */
const AUTHORED_ON = DateTime.unsafeMake('2026-01-05T18:00:00Z')

/** The `ExerciseRequest` `planned` makes, stored as `sr-1`, at a load of `value` in the rule's unit. */
const exerciseRequestAt = (planned: PlannedExercise.Type, value: number): ExerciseRequest.Type =>
  made(
    ExerciseRequest.make({
      serviceRequestId: 'sr-1',
      subject: SUBJECT,
      plan: planRunning(planned),
      exerciseId: PlannedExercise.exerciseIdOf(planned),
      load: made(
        Load.make({
          value,
          unit: ProgressionRule.unitOf(PlannedExercise.progressionRuleOf(planned)),
        })
      ),
      authoredOn: AUTHORED_ON,
    })
  )

/** A planned exercise and an `ExerciseRequest` it makes. */
interface PlannedExerciseRequest {
  readonly planned: PlannedExercise.Type
  readonly exerciseRequest: ExerciseRequest.Type
}

/** An `ExerciseRequest` for `planned`, its load at least `above` over the rule's floor. */
const plannedExerciseRequestForArb = (
  planned: PlannedExercise.Type,
  above = 0
): fc.Arbitrary<PlannedExerciseRequest> =>
  fc
    .oneof(
      fc.constant(above),
      amountArb.map((amount) => amount + above)
    )
    .map((extra) => ({
      planned,
      exerciseRequest: exerciseRequestAt(
        planned,
        ProgressionRule.minimumLoadOf(PlannedExercise.progressionRuleOf(planned)) + extra
      ),
    }))

/** A planned exercise and an `ExerciseRequest` in range for it. */
const plannedExerciseRequestArb: fc.Arbitrary<PlannedExerciseRequest> = plannedArb.chain(
  (planned) => plannedExerciseRequestForArb(planned)
)

/** Any `ExerciseRequest`, in range, at either unit. */
const exerciseRequestArb: fc.Arbitrary<ExerciseRequest.Type> = plannedExerciseRequestArb.map(
  ({ exerciseRequest }) => exerciseRequest
)

/** Milliseconds one generated set takes, start to end. */
const SET_LENGTH_MS = 60_000

/** Milliseconds between the starts of consecutive sets of one session. */
const SET_GAP_MS = 180_000

/** A set of `reps` against `exerciseRequest`, starting at `start` and lasting {@link SET_LENGTH_MS}. */
const setAt = ({
  exerciseRequest,
  workoutLabel,
  start,
  reps,
}: {
  readonly exerciseRequest: ExerciseRequest.Type
  readonly workoutLabel: string
  readonly start: DateTime.Utc
  readonly reps: number
}): ExerciseSetObservation.Type =>
  made(
    ExerciseSetObservation.make({
      observationId: `set-${DateTime.toEpochMillis(start)}`,
      exerciseRequest,
      workoutLabel,
      start,
      end: DateTime.addDuration(start, `${SET_LENGTH_MS} millis`),
      reps,
    })
  )

/** The 18:00 UTC instant of the `index`th session day of a generated history, one day apart. */
const sessionAt = (index: number): DateTime.Utc =>
  DateTime.unsafeMake(Date.UTC(2026, 0, 1, 18) + index * 86_400_000)

/** The sets of one session on session day `index`: one set per entry of `reps`, {@link SET_GAP_MS} apart. */
const sessionSets = ({
  exerciseRequest,
  index,
  reps,
}: {
  readonly exerciseRequest: ExerciseRequest.Type
  readonly index: number
  readonly reps: readonly number[]
}): readonly ExerciseSetObservation.Type[] =>
  reps.map((setReps, setIndex) =>
    setAt({
      exerciseRequest,
      workoutLabel: index % 2 === 0 ? 'A' : 'B',
      start: DateTime.addDuration(sessionAt(index), `${setIndex * SET_GAP_MS} millis`),
      reps: setReps,
    })
  )

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
 * few — but never no set at all, since a session is its sets.
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

/** An `ExerciseRequest`, the sets logged against it, and the decision they call for. */
interface ProgressionCase {
  readonly expected: ExerciseRequest.Decision
  readonly planned: PlannedExercise.Type
  readonly exerciseRequest: ExerciseRequest.Type
  readonly setObservations: readonly ExerciseSetObservation.Type[]
  /** The trailing failed sessions the history ends with. */
  readonly trailingFailures: number
}

/**
 * A history of sessions — a prior stretch succeeding or failing, then `tail`
 * — as sets, session `i` on day {@link sessionAt}`(i)`, so the tail is always
 * the most recent.
 */
const caseFrom = (spec: {
  readonly expected: ExerciseRequest.Decision
  readonly plannedExerciseRequest: PlannedExerciseRequest
  readonly tail: fc.Arbitrary<readonly (readonly number[])[]>
  readonly trailingFailures: (tailLength: number) => number
}): fc.Arbitrary<ProgressionCase> => {
  const { exerciseRequest, planned } = spec.plannedExerciseRequest
  return fc
    .tuple(
      fc.array(fc.oneof(successfulRepsArb(exerciseRequest), failedRepsArb(exerciseRequest)), {
        maxLength: 4,
      }),
      spec.tail
    )
    .map(([prior, sessions]) => ({
      expected: spec.expected,
      planned,
      exerciseRequest,
      setObservations: [...prior, ...sessions].flatMap((reps, index) =>
        sessionSets({ exerciseRequest, index, reps })
      ),
      trailingFailures: spec.trailingFailures(sessions.length),
    }))
}

/** The rule of a planned exercise. */
const ruleOf = (planned: PlannedExercise.Type): ProgressionRule.Type =>
  PlannedExercise.progressionRuleOf(planned)

/** The latest session met the `ExerciseRequest`. */
const incrementCaseArb: fc.Arbitrary<ProgressionCase> = plannedExerciseRequestArb.chain(
  (plannedExerciseRequest) =>
    caseFrom({
      expected: 'increment',
      plannedExerciseRequest,
      tail: successfulRepsArb(plannedExerciseRequest.exerciseRequest).map((reps) => [reps]),
      trailingFailures: () => 0,
    })
)

/** Enough trailing failures at a load with room above its floor. */
const deloadCaseArb: fc.Arbitrary<ProgressionCase> = plannedArb
  .chain((planned) => plannedExerciseRequestForArb(planned, 1))
  .chain((plannedExerciseRequest) => {
    const failures = ProgressionRule.failuresBeforeDeloadOf(ruleOf(plannedExerciseRequest.planned))
    return caseFrom({
      expected: 'deload',
      plannedExerciseRequest,
      tail: fc.array(failedRepsArb(plannedExerciseRequest.exerciseRequest), {
        minLength: failures,
        maxLength: failures + 2,
      }),
      trailingFailures: (count) => count,
    })
  })

/**
 * Too few trailing failures: a met session, then fewer failures than a deload
 * waits for — which needs a rule that waits for at least two.
 */
const fewFailuresCaseArb: fc.Arbitrary<ProgressionCase> = fc
  .record({
    exercise: exerciseArb,
    rule: progressionRuleInputArb.map((rule) => ({
      ...rule,
      failuresBeforeDeload: Math.max(2, rule.failuresBeforeDeload),
    })),
    sets: fc.integer({ min: 1, max: 10 }),
    reps: fc.integer({ min: 1, max: 20 }),
  })
  .map(({ exercise, rule, sets, reps }) =>
    made(
      PlannedExercise.make({
        exercise,
        sets,
        reps,
        progressionRule: made(ProgressionRule.make(rule)),
      })
    )
  )
  .chain((planned) => plannedExerciseRequestForArb(planned))
  .chain((plannedExerciseRequest) =>
    caseFrom({
      expected: 'hold',
      plannedExerciseRequest,
      tail: fc
        .tuple(
          successfulRepsArb(plannedExerciseRequest.exerciseRequest),
          fc.array(failedRepsArb(plannedExerciseRequest.exerciseRequest), {
            minLength: 1,
            maxLength:
              ProgressionRule.failuresBeforeDeloadOf(ruleOf(plannedExerciseRequest.planned)) - 1,
          })
        )
        .map(([met, failures]) => [met, ...failures]),
      trailingFailures: (count) => count - 1,
    })
  )

/** Enough trailing failures, but the load is already at its floor. */
const atFloorCaseArb: fc.Arbitrary<ProgressionCase> = plannedArb
  .map((planned) => ({
    planned,
    exerciseRequest: exerciseRequestAt(planned, ProgressionRule.minimumLoadOf(ruleOf(planned))),
  }))
  .chain((plannedExerciseRequest) => {
    const failures = ProgressionRule.failuresBeforeDeloadOf(ruleOf(plannedExerciseRequest.planned))
    return caseFrom({
      expected: 'hold',
      plannedExerciseRequest,
      tail: fc.array(failedRepsArb(plannedExerciseRequest.exerciseRequest), {
        minLength: failures,
        maxLength: failures + 2,
      }),
      trailingFailures: (count) => count,
    })
  })

/** Never attempted: no sets at all. */
const unattemptedCaseArb: fc.Arbitrary<ProgressionCase> = plannedExerciseRequestArb.map(
  ({ planned, exerciseRequest }) => ({
    expected: 'hold' as const,
    planned,
    exerciseRequest,
    setObservations: [],
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
  exerciseArb,
  exerciseIdArb,
  exerciseRequestArb,
  exerciseRequestAt,
  failedRepsArb,
  fewFailuresCaseArb,
  incrementCaseArb,
  instantArb,
  issuePathsOf,
  loadUnitArb,
  made,
  nonBlankStringArb,
  planArb,
  plannedArb,
  progressionCaseArb,
  progressionRuleArb,
  progressionRuleInputArb,
  plannedExerciseRequestArb,
  ruleOf,
  setAt,
  smallPlanArb,
  someOrFail,
  SUBJECT,
  successfulRepsArb,
  throughWire,
  UTC,
  workoutLabelArb,
  zoneArb,
}
export type { ProgressionCase, PlannedExerciseRequest }
