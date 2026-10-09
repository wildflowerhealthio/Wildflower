import {
  Array as Arr,
  type Brand,
  type Either,
  Option,
  type ParseResult,
  pipe,
  Schema,
} from 'effect'
import { narrowFields, WILDFLOWER_CANONICAL_BASE, withMandatoryId } from 'fhir-r4/data-types'
import { PlanDefinition } from 'fhir-r4/resources'

import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import { narrowedFrom } from '../internal/narrowed-from.ts'
import * as LiftingFeature from '../lifting-feature/lifting-feature.ts'
import * as WorkoutProcedure from '../workout-procedure/workout-procedure.ts'
import * as TrainingPlanDefinitionDay from './day.ts'
import * as TrainingPlanDefinitionExercise from './exercise.ts'
import * as TrainingPlanDefinitionProgressionRule from './progression-rule.ts'

/**
 * A strength-training plan definition, as FHIR carries it: a `PlanDefinition`
 * narrowed to an `id`, a canonical `url` its `ExerciseRequest`s instantiate,
 * a non-empty, trimmed `title`, and at least one `action`, each a day — a
 * {@link TrainingPlanDefinitionDay.Type} — in cycle order: after the last
 * comes the first again.
 *
 * @remarks
 * A training plan definition is the program, not the lifter's state: it says
 * how each exercise is run and how its load moves, never what the load is. An
 * exercise on more than one day (StrongLifts' squat) has an exercise
 * (definition) on each, identical: the schema refuses one defined two ways.
 * Day labels are distinct. Any edit goes back through {@link make}.
 */
interface TrainingPlanDefinition
  extends
    Omit<PlanDefinition.Type, 'id' | 'url' | 'title' | 'action'>,
    Brand.Brand<'TrainingPlanDefinition'> {
  /** The id the `PlanDefinition` is stored under. */
  readonly id: string
  /** The canonical url an `ExerciseRequest` names in `instantiatesCanonical`. */
  readonly url: string
  /** Human-friendly name, e.g. `"StrongLifts 5×5"`. */
  readonly title: string
  /** The days in cycle order. */
  readonly action: Arr.NonEmptyReadonlyArray<TrainingPlanDefinitionDay.Type>
}

/** Whether two exercises (definitions) run their exercise the same way. */
const isDefinedAlike = ({
  firstTrainingPlanDefinitionExercise,
  laterTrainingPlanDefinitionExercise,
}: {
  readonly firstTrainingPlanDefinitionExercise: TrainingPlanDefinitionExercise.Type
  readonly laterTrainingPlanDefinitionExercise: TrainingPlanDefinitionExercise.Type
}): boolean => {
  const firstProgressionRule = TrainingPlanDefinitionExercise.progressionRuleOf(
    firstTrainingPlanDefinitionExercise
  )
  const laterProgressionRule = TrainingPlanDefinitionExercise.progressionRuleOf(
    laterTrainingPlanDefinitionExercise
  )
  return (
    ExerciseConcept.nameOf(
      TrainingPlanDefinitionExercise.exerciseConceptOf(firstTrainingPlanDefinitionExercise)
    ) ===
      ExerciseConcept.nameOf(
        TrainingPlanDefinitionExercise.exerciseConceptOf(laterTrainingPlanDefinitionExercise)
      ) &&
    TrainingPlanDefinitionExercise.setsOf(firstTrainingPlanDefinitionExercise) ===
      TrainingPlanDefinitionExercise.setsOf(laterTrainingPlanDefinitionExercise) &&
    TrainingPlanDefinitionExercise.repsOf(firstTrainingPlanDefinitionExercise) ===
      TrainingPlanDefinitionExercise.repsOf(laterTrainingPlanDefinitionExercise) &&
    TrainingPlanDefinitionProgressionRule.unitOf(firstProgressionRule) ===
      TrainingPlanDefinitionProgressionRule.unitOf(laterProgressionRule) &&
    TrainingPlanDefinitionProgressionRule.incrementOf(firstProgressionRule) ===
      TrainingPlanDefinitionProgressionRule.incrementOf(laterProgressionRule) &&
    TrainingPlanDefinitionProgressionRule.failuresBeforeDeloadOf(firstProgressionRule) ===
      TrainingPlanDefinitionProgressionRule.failuresBeforeDeloadOf(laterProgressionRule) &&
    TrainingPlanDefinitionProgressionRule.deloadFractionOf(firstProgressionRule) ===
      TrainingPlanDefinitionProgressionRule.deloadFractionOf(laterProgressionRule) &&
    TrainingPlanDefinitionProgressionRule.minimumLoadOf(firstProgressionRule) ===
      TrainingPlanDefinitionProgressionRule.minimumLoadOf(laterProgressionRule) &&
    TrainingPlanDefinitionProgressionRule.loadStepOf(firstProgressionRule) ===
      TrainingPlanDefinitionProgressionRule.loadStepOf(laterProgressionRule)
  )
}

/** The narrowed fields, before the checks across days. */
const NarrowedPlanDefinition = narrowFields(
  Schema.typeSchema(withMandatoryId(PlanDefinition.Schema)),
  {
    url: Schema.String,
    title: Schema.NonEmptyTrimmedString,
    action: Schema.NonEmptyArray(Schema.typeSchema(TrainingPlanDefinitionDay.Schema)),
  }
)

/** A training plan definition as {@link NarrowedPlanDefinition} decodes it, for the checks across days. */
type NarrowedTrainingPlanDefinition = typeof NarrowedPlanDefinition.Type

/** The issues of every day whose label an earlier day already has, each at that day's `title`. */
const repeatedDayLabelIssues = (
  trainingPlanDefinition: NarrowedTrainingPlanDefinition
): readonly Schema.FilterIssue[] => {
  const dayLabels = trainingPlanDefinition.action.map(TrainingPlanDefinitionDay.labelOf)
  return dayLabels.flatMap((dayLabel, dayIndex) =>
    dayLabels.indexOf(dayLabel) === dayIndex
      ? []
      : [
          {
            path: ['action', dayIndex, 'title'],
            message: `expected a label no other day has, actual ${JSON.stringify(dayLabel)}`,
          },
        ]
  )
}

/**
 * The issues of every exercise (definition) that runs its exercise unlike the
 * first one for the same exercise, each at that exercise (definition).
 */
const exerciseDefinedTwoWaysIssues = (
  trainingPlanDefinition: NarrowedTrainingPlanDefinition
): readonly Schema.FilterIssue[] => {
  const located = trainingPlanDefinition.action.flatMap((trainingPlanDefinitionDay, dayIndex) =>
    TrainingPlanDefinitionDay.exercisesOf(trainingPlanDefinitionDay).map(
      (trainingPlanDefinitionExercise, exerciseIndex) => ({
        trainingPlanDefinitionExercise,
        path: ['action', dayIndex, 'action', exerciseIndex],
      })
    )
  )
  return located.flatMap((locatedExercise) => {
    const { trainingPlanDefinitionExercise, path } = locatedExercise
    const exerciseId = TrainingPlanDefinitionExercise.exerciseIdOf(trainingPlanDefinitionExercise)
    return pipe(
      Arr.findFirst(
        located,
        (firstLocatedExercise) =>
          TrainingPlanDefinitionExercise.exerciseIdOf(
            firstLocatedExercise.trainingPlanDefinitionExercise
          ) === exerciseId
      ),
      Option.filter(
        (firstLocatedExercise) =>
          firstLocatedExercise !== locatedExercise &&
          !isDefinedAlike({
            firstTrainingPlanDefinitionExercise:
              firstLocatedExercise.trainingPlanDefinitionExercise,
            laterTrainingPlanDefinitionExercise: trainingPlanDefinitionExercise,
          })
      ),
      Option.match({
        onNone: () => [],
        onSome: () => [
          { path, message: `expected "${exerciseId}" defined as on the first day that runs it` },
        ],
      })
    )
  })
}

/**
 * Decodes a `PlanDefinition` into a {@link TrainingPlanDefinition} — fails,
 * naming the field, on no `id` or `url`, an empty or untrimmed `title`, no
 * day, a day that does not decode, two days with one label, or one exercise
 * defined two ways.
 */
const TrainingPlanDefinitionSchema: Schema.Schema<TrainingPlanDefinition, PlanDefinition.Type> =
  narrowedFrom<PlanDefinition.Type>()(
    NarrowedPlanDefinition.pipe(
      Schema.filter((trainingPlanDefinition) => [
        ...repeatedDayLabelIssues(trainingPlanDefinition),
        ...exerciseDefinedTwoWaysIssues(trainingPlanDefinition),
      ]),
      Schema.brand('TrainingPlanDefinition')
    )
  )

/** A decoded `PlanDefinition` with every optional slot empty, for a training plan definition to be spread onto. */
const emptyPlanDefinition: PlanDefinition.Type = Schema.decodeSync(PlanDefinition.Schema)({
  resourceType: 'PlanDefinition',
  status: 'active',
})

/**
 * The training plan definition `title`, stored under `planDefinitionId`,
 * cycling through `trainingPlanDefinitionDays` in order: `active`, filed under
 * the `strength-training` feature `topic`, its canonical `url` under
 * `WILDFLOWER_CANONICAL_BASE`.
 *
 * @returns The training plan definition; or a `ParseError` naming every
 *   problem: an empty or untrimmed title, no days, two days with one label,
 *   or one exercise defined two ways
 */
const make = (trainingPlanDefinition: {
  readonly planDefinitionId: string
  readonly title: string
  readonly trainingPlanDefinitionDays: readonly TrainingPlanDefinitionDay.Type[]
}): Either.Either<TrainingPlanDefinition, ParseResult.ParseError> =>
  Schema.decodeEither(TrainingPlanDefinitionSchema, { errors: 'all' })({
    ...emptyPlanDefinition,
    id: trainingPlanDefinition.planDefinitionId,
    url: `${WILDFLOWER_CANONICAL_BASE}/PlanDefinition/${trainingPlanDefinition.planDefinitionId}`,
    status: 'active',
    title: trainingPlanDefinition.title,
    topic: [LiftingFeature.concept],
    action: trainingPlanDefinition.trainingPlanDefinitionDays,
  })

/** The days in cycle order. */
const daysOf = (
  trainingPlanDefinition: TrainingPlanDefinition
): Arr.NonEmptyReadonlyArray<TrainingPlanDefinitionDay.Type> => trainingPlanDefinition.action

/**
 * Each exercise (definition) the training plan definition runs, once per
 * exercise, in the order the days first run it.
 */
const exercisesOf = (
  trainingPlanDefinition: TrainingPlanDefinition
): readonly TrainingPlanDefinitionExercise.Type[] =>
  Arr.dedupeWith(
    trainingPlanDefinition.action.flatMap(TrainingPlanDefinitionDay.exercisesOf),
    (left, right) =>
      TrainingPlanDefinitionExercise.exerciseIdOf(left) ===
      TrainingPlanDefinitionExercise.exerciseIdOf(right)
  )

/**
 * The exercise (definition) by which the training plan definition runs the
 * exercise `exerciseId`; `None` when it does not run it.
 */
const exerciseOf = ({
  trainingPlanDefinition,
  exerciseId,
}: {
  readonly trainingPlanDefinition: TrainingPlanDefinition
  readonly exerciseId: string
}): Option.Option<TrainingPlanDefinitionExercise.Type> =>
  Arr.findFirst(
    trainingPlanDefinition.action.flatMap(TrainingPlanDefinitionDay.exercisesOf),
    (trainingPlanDefinitionExercise) =>
      TrainingPlanDefinitionExercise.exerciseIdOf(trainingPlanDefinitionExercise) === exerciseId
  )

/**
 * The day due next: the one after the day `latestCompletedWorkoutProcedure`
 * performed, in `trainingPlanDefinition`'s cycle order, wrapping from the last
 * back to the first. `latestCompletedWorkoutProcedure` is the lifter's most
 * recent completed workout under it, as `WorkoutProcedure.latestCompleted`
 * finds it — `None` before the first.
 *
 * @remarks
 * With no completed workout — or one whose day label names no day of the
 * training plan definition, as after its days were replaced — the cycle
 * starts over at the first day.
 */
const nextDay = ({
  trainingPlanDefinition,
  latestCompletedWorkoutProcedure,
}: {
  readonly trainingPlanDefinition: TrainingPlanDefinition
  readonly latestCompletedWorkoutProcedure: Option.Option<WorkoutProcedure.Type>
}): TrainingPlanDefinitionDay.Type =>
  pipe(
    latestCompletedWorkoutProcedure,
    Option.flatMap((workoutProcedure) =>
      Arr.findFirstIndex(
        trainingPlanDefinition.action,
        (trainingPlanDefinitionDay) =>
          TrainingPlanDefinitionDay.labelOf(trainingPlanDefinitionDay) ===
          WorkoutProcedure.dayLabelOf(workoutProcedure)
      )
    ),
    Option.flatMap((dayIndex) =>
      Arr.get(trainingPlanDefinition.action, (dayIndex + 1) % trainingPlanDefinition.action.length)
    ),
    Option.getOrElse(() => Arr.headNonEmpty(trainingPlanDefinition.action))
  )

export { daysOf, exerciseOf, exercisesOf, make, nextDay, TrainingPlanDefinitionSchema as Schema }
export type { TrainingPlanDefinition as Type }
export * as Day from './day.ts'
export * as Exercise from './exercise.ts'
export * as ProgressionRule from './progression-rule.ts'
