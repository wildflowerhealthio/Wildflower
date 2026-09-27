import { Array as Arr, Data, DateTime, Either, Option, pipe, Record, Schema } from 'effect'
import type { IdentifierAndReference } from 'fhir-r4/data-types'
import { CarePlan, CarePlanActivity, CarePlanActivityDetail } from 'fhir-r4/resources'

import { goalsFor } from '../cycle.ts'
import {
  describeProblem,
  type ExerciseGoal,
  makePlan,
  type Plan,
  type PlanProblem,
  type Workout,
} from '../plan.ts'
import {
  exactlyOne,
  exerciseConcept,
  exerciseIdOf,
  liftingPlanCategory,
  referenceOf,
  referenceTo,
  workoutLabelExtension,
  workoutLabelOf,
} from './elements.ts'
import {
  exerciseGoalFromFhir,
  exerciseGoalToFhir,
  type GoalReadProblem,
  type GoalResource,
} from './goal.ts'

/** A decoded FHIR R4 `CarePlan`. */
type CarePlanResource = CarePlan.Type

type Activity = typeof CarePlanActivity.Schema.Type

/** A plan as FHIR R4 resources: the `CarePlan` and the `Goal` per exercise it references. */
interface PlanResources {
  /** The plan: its title, goal references, and one activity per workout exercise. */
  readonly carePlan: CarePlanResource
  /** One `Goal` per exercise, in the order the `CarePlan` references them. */
  readonly goals: readonly GoalResource[]
}

/**
 * A plan as it is stored: the plan, the ids its `CarePlan` and `Goal`s are
 * stored under, and when the `CarePlan` was created — what an app needs to
 * rewrite the same resources rather than mint new ones.
 */
interface StoredPlan {
  /** The plan the resources hold. */
  readonly plan: Plan
  /** The `CarePlan.id` the plan is stored under. */
  readonly carePlanId: string
  /** The `Goal.id` each exercise's goal is stored under, by exercise id. */
  readonly goalIdByExerciseId: Readonly<Record<string, string>>
  /** `CarePlan.created`, or `None` when the `CarePlan` carries none. */
  readonly created: Option.Option<DateTime.Utc>
}

/** Options for {@link planToFhir}. */
interface PlanToFhirOptions {
  /** The `CarePlan.id` to write; the app mints it. */
  readonly carePlanId: string
  /** When the plan was created, written as `CarePlan.created`. */
  readonly created: DateTime.Utc
  /** The `Goal.id` to write for each exercise, by exercise id; the app mints them. */
  readonly goalIdFor: (exerciseId: string) => string
  /** The patient the plan is for, as a literal reference (`Patient/p-1`). */
  readonly subject: string
}

/** One reason {@link planFromFhir} could not read a `CarePlan` and its goals, beyond a {@link PlanProblem}. */
type PlanReadProblem = Data.TaggedEnum<{
  /** The `CarePlan` has no `id`, so there is nothing to store an edit under. */
  CarePlanIdMissing: Record<never, never>
  /** `CarePlan.created` is present but is not a FHIR `dateTime` naming a real instant. */
  CreatedUnreadable: { readonly created: string }
  /** `CarePlan.goal` references a goal that is not among the goals given. */
  GoalMissing: { readonly reference: string | null }
  /** More than one of the goals given has the referenced id, so which one is meant is unknown. */
  GoalAmbiguous: { readonly reference: string }
  /** The referenced goal is given but could not be read. */
  ReferencedGoalUnreadable: {
    readonly reference: string
    readonly problems: Arr.NonEmptyReadonlyArray<GoalReadProblem>
  }
  /** Activity `index` (0-based) has no detail with a single workout label. */
  ActivityUnlabelled: { readonly index: number }
  /** Activity `index` (0-based) has no detail with a single exercise coding. */
  ActivityUncoded: { readonly index: number }
  /** A workout's activities are not contiguous: its label recurs after another workout's. */
  WorkoutLabelSplit: { readonly label: string }
}>

/** Constructors and matchers for {@link PlanReadProblem}. */
const PlanReadProblem = Data.taggedEnum<PlanReadProblem>()

/**
 * A `CarePlan` and its goals could not be read back as a {@link Plan}.
 *
 * @remarks
 * Reading reports every problem it finds rather than stopping at the first, so
 * a UI can say everything that is wrong at once. The plan-level problems are
 * the ones `makePlan` reports, over what could be read.
 */
class PlanUnreadable extends Data.TaggedError('PlanUnreadable')<{
  /** Every reason the plan could not be read. */
  readonly problems: Arr.NonEmptyReadonlyArray<PlanReadProblem | PlanProblem>
}> {
  // Data.TaggedError leaves `.message` empty by default; name the problems so
  // a logged or thrown refusal says what was wrong.
  override get message(): string {
    return `plan unreadable: ${this.problems.map(describeProblem).join('; ')}`
  }
}

/** A decoded `CarePlan.activity` with every slot empty, for a detail to be spread onto. */
const emptyActivity: Activity = Schema.decodeSync(CarePlanActivity.Schema)({})

/** A decoded `CarePlan.activity.detail` with every optional slot empty. */
const emptyDetail: typeof CarePlanActivityDetail.Schema.Type = Schema.decodeSync(
  CarePlanActivityDetail.Schema
)({ status: 'in-progress' })

/** A decoded `CarePlan` with every optional slot empty, for the plan's fields to be spread onto. */
const emptyCarePlan: CarePlanResource = Schema.decodeSync(CarePlan.Schema)({
  resourceType: 'CarePlan',
  status: 'active',
  intent: 'plan',
  subject: {},
})

/**
 * A plan as FHIR R4 resources, after HL7's Physical Activity IG: an `active`
 * `plan`-intent `CarePlan` referencing one `Goal` per exercise, with one
 * `in-progress` activity per exercise of each workout — its exercise as the
 * coded `detail.code`, its goal in `detail.goal`, and its workout's label in a
 * {@link WildflowerExtension.WorkoutLabel} extension — in cycle order, each
 * workout's activities contiguous.
 *
 * @param plan - The plan to write
 * @param options - The ids the app minted for the resources, their subject, and
 *   when the plan was created (written as `CarePlan.created`)
 * @returns The decoded `CarePlan` and `Goal`s, ready to encode
 */
const planToFhir = (plan: Plan, options: PlanToFhirOptions): PlanResources => {
  const goalReference = (exerciseId: string): IdentifierAndReference.ReferenceType =>
    referenceTo('Goal', options.goalIdFor(exerciseId))
  const activitiesOf = (workout: Workout): readonly Activity[] =>
    goalsFor(plan, workout).map((goal): Activity => ({
      ...emptyActivity,
      detail: {
        ...emptyDetail,
        status: 'in-progress',
        code: exerciseConcept(goal.exercise),
        goal: [goalReference(goal.exercise.id)],
        extension: [workoutLabelExtension(workout.label)],
      },
    }))
  return {
    carePlan: {
      ...emptyCarePlan,
      id: options.carePlanId,
      created: DateTime.formatIso(options.created),
      status: 'active',
      intent: 'plan',
      category: [liftingPlanCategory],
      title: plan.title,
      subject: referenceOf(options.subject),
      goal: Record.keys(plan.goalsByExerciseId).map(goalReference),
      activity: plan.workouts.flatMap(activitiesOf),
    },
    goals: Record.values(
      Record.map(plan.goalsByExerciseId, (goal, exerciseId) =>
        exerciseGoalToFhir(goal, {
          goalId: options.goalIdFor(exerciseId),
          subject: options.subject,
        })
      )
    ),
  }
}

/** One activity read as the workout it belongs to and the exercise it runs. */
interface WorkoutStep {
  readonly label: string
  readonly exerciseId: string
}

/** The workout label and exercise an activity carries, or every reason it carries none. */
const workoutStepOf = (
  activity: Activity,
  index: number
): Either.Either<WorkoutStep, readonly PlanReadProblem[]> => {
  const label = Option.flatMap(Option.fromNullable(activity.detail), (detail) =>
    workoutLabelOf(detail.extension)
  )
  const exerciseId = Option.flatMap(Option.fromNullable(activity.detail), (detail) =>
    exerciseIdOf(detail.code)
  )
  return pipe(
    Option.all({ label, exerciseId }),
    Either.fromOption(() => [
      ...(Option.isNone(label) ? [PlanReadProblem.ActivityUnlabelled({ index })] : []),
      ...(Option.isNone(exerciseId) ? [PlanReadProblem.ActivityUncoded({ index })] : []),
    ])
  )
}

/** An exercise goal read off a referenced `Goal`, with the id that `Goal` is stored under. */
interface ReferencedGoal {
  readonly exerciseGoal: ExerciseGoal
  readonly goalId: string
}

/**
 * The exercise goal a `CarePlan.goal` reference points at among `goals` — the
 * one goal with that id — with that id, or why it can't be read.
 */
const referencedGoalOf =
  (goals: readonly GoalResource[]) =>
  (
    reference: IdentifierAndReference.ReferenceType
  ): Either.Either<ReferencedGoal, PlanReadProblem> => {
    const literal = reference.reference
    if (literal === null) return Either.left(PlanReadProblem.GoalMissing({ reference: literal }))
    const candidates = Arr.filterMap(goals, (goal) =>
      goal.id !== null && `Goal/${goal.id}` === literal
        ? Option.some({ goal, goalId: goal.id })
        : Option.none()
    )
    const referenced: Either.Either<
      { readonly goal: GoalResource; readonly goalId: string },
      PlanReadProblem
    > = Arr.match(candidates, {
      onEmpty: () => Either.left(PlanReadProblem.GoalMissing({ reference: literal })),
      onNonEmpty: (found) =>
        Either.fromOption(exactlyOne(found), () =>
          PlanReadProblem.GoalAmbiguous({ reference: literal })
        ),
    })
    return pipe(
      referenced,
      Either.flatMap(({ goal, goalId }) =>
        Either.mapBoth(exerciseGoalFromFhir(goal), {
          onLeft: (unreadable) =>
            PlanReadProblem.ReferencedGoalUnreadable({
              reference: literal,
              problems: unreadable.problems,
            }),
          onRight: (exerciseGoal): ReferencedGoal => ({ exerciseGoal, goalId }),
        })
      )
    )
  }

/** Adjacent steps with one label, as one workout each. */
const workoutRunsOf = (
  steps: readonly WorkoutStep[]
): readonly { readonly label: string; readonly exerciseIds: readonly string[] }[] =>
  Arr.match(steps, {
    onEmpty: () => [],
    onNonEmpty: (nonEmptySteps) =>
      Arr.groupWith(nonEmptySteps, (left, right) => left.label === right.label).map((run) => ({
        label: Arr.headNonEmpty(run).label,
        exerciseIds: run.map((step) => step.exerciseId),
      })),
  })

/**
 * FHIR R4's `dateTime` form: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or a full
 * date-time to the second, fraction optional, with a mandatory zone (`Z` or
 * `±hh:mm`). A zone-less time is not a `dateTime`, and anything else `Date`
 * would guess at is refused rather than parsed.
 */
const FHIR_DATE_TIME =
  /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01])(T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]{1,9})?(Z|[+-]((0[0-9]|1[0-3]):[0-5][0-9]|14:00)))?)?)?$/

/**
 * `CarePlan.created` as an instant, `None` when absent, or the problem when it
 * is not a FHIR `dateTime`.
 *
 * @remarks
 * Only a string in the {@link FHIR_DATE_TIME} form reaches `DateTime.make`:
 * each form it accepts is either date-only (read as the start of that UTC day,
 * month or year) or carries its own zone, so no local-time guess is made. A
 * form that names no real instant (`T24:…`, a leap second) is refused too.
 */
const createdOf = (
  carePlan: CarePlanResource
): Either.Either<Option.Option<DateTime.Utc>, PlanReadProblem> => {
  const created = carePlan.created
  if (created === null || created === undefined) return Either.right(Option.none())
  return pipe(
    Option.liftPredicate(created, (text) => FHIR_DATE_TIME.test(text)),
    Option.flatMap((text: string) => DateTime.make(text)),
    Option.map(DateTime.toUtc),
    Either.fromOption(() => PlanReadProblem.CreatedUnreadable({ created })),
    Either.map(Option.some)
  )
}

/**
 * The stored plan a `CarePlan` and its goals, written by {@link planToFhir}, hold.
 *
 * @param carePlan - A decoded `CarePlan`
 * @param goals - Decoded `Goal`s; the ones `carePlan.goal` references are
 *   read, any others are ignored
 * @returns The {@link StoredPlan} — the plan, the `CarePlan` id, each
 *   exercise's `Goal` id and `created` — or {@link PlanUnreadable} listing
 *   every problem: each {@link PlanReadProblem} (no `CarePlan.id`, a `created`
 *   that is not a date-time, a referenced goal missing, ambiguous — two goals
 *   given with its id — or unreadable, an
 *   activity without a single workout label or exercise coding, a workout
 *   whose activities are split by another's), and each `PlanProblem`
 *   `makePlan` finds in what could be read (no title, two goals for one
 *   exercise, a workout exercise with no goal, no workouts, …)
 *
 * @remarks
 * All-or-nothing, so nothing disappears silently: a plan missing one goal
 * cannot prescribe that exercise, so it is refused whole rather than read
 * with the exercise quietly dropped. An unreadable goal therefore also shows
 * up as each workout exercise it leaves without a goal. `CarePlan.status` is
 * not checked — the caller decides which plans are current. `detail.goal` is
 * written for FHIR readers; this reader matches a workout exercise to its goal
 * by exercise id.
 */
const planFromFhir = (
  carePlan: CarePlanResource,
  goals: readonly GoalResource[]
): Either.Either<StoredPlan, PlanUnreadable> => {
  const carePlanId = Either.fromNullable(carePlan.id, () => PlanReadProblem.CarePlanIdMissing())
  const created = createdOf(carePlan)
  const [goalProblems, referencedGoals] = Arr.partitionMap(carePlan.goal, referencedGoalOf(goals))
  const [stepProblems, steps] = Arr.partitionMap(carePlan.activity, workoutStepOf)
  const runs = workoutRunsOf(steps)
  const splitLabels = Arr.dedupe(
    runs.map((run) => run.label).filter((label, index, labels) => labels.indexOf(label) !== index)
  )
  const planRead = makePlan({
    title: carePlan.title ?? '',
    goals: referencedGoals.map((referenced) => referenced.exerciseGoal),
    workouts: Arr.dedupeWith(runs, (left, right) => left.label === right.label),
  })
  const problems = [
    ...Arr.getLefts([carePlanId, created]),
    ...goalProblems,
    ...stepProblems.flat(),
    ...splitLabels.map((label) => PlanReadProblem.WorkoutLabelSplit({ label })),
    ...Either.match(planRead, { onLeft: (invalid) => invalid.problems, onRight: () => [] }),
  ]
  return Arr.match(problems, {
    onNonEmpty: (found) => Either.left(new PlanUnreadable({ problems: found })),
    onEmpty: () =>
      Either.all({
        plan: Either.mapLeft(planRead, (invalid) => invalid.problems),
        carePlanId: Either.mapLeft(carePlanId, Arr.of),
        created: Either.mapLeft(created, Arr.of),
      }).pipe(
        Either.mapBoth({
          onLeft: (found) => new PlanUnreadable({ problems: found }),
          onRight: ({ plan, carePlanId: storedId, created: createdAt }): StoredPlan => ({
            plan,
            carePlanId: storedId,
            goalIdByExerciseId: Record.fromEntries(
              referencedGoals.map(({ exerciseGoal, goalId }) => [exerciseGoal.exercise.id, goalId])
            ),
            created: createdAt,
          }),
        })
      ),
  })
}

export { planFromFhir, PlanReadProblem, PlanUnreadable, planToFhir }
export type { CarePlanResource, PlanResources, PlanToFhirOptions, StoredPlan }
