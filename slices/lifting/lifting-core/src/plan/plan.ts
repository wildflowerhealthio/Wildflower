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

import * as ExerciseSetObservation from '../exercise-set-observation/exercise-set-observation.ts'
import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import { narrowedFrom } from '../internal/narrowed-from.ts'
import { NonBlankString } from '../internal/non-blank-string.ts'
import { liftingFeatureConcept } from '../terminology.ts'
import * as PlannedExercise from './planned-exercise.ts'
import * as ProgressionRule from './progression-rule.ts'
import * as Workout from './workout.ts'

/**
 * A strength-training plan, as FHIR carries it: a `PlanDefinition` narrowed to
 * an `id`, a canonical `url` its `ExerciseRequest`s instantiate, a non-blank
 * `title`, and at least one `action`, each a {@link Workout.Type}, in cycle
 * order — after the last comes the first again.
 *
 * @remarks
 * A plan is the program, not the lifter's state: it says how each exercise is
 * run and how its load moves, never what the load is. An exercise in more
 * than one workout (StrongLifts' squat) is planned in each, identically: the
 * schema refuses one planned two ways. Workout labels are distinct. Any edit
 * goes back through {@link make}.
 */
interface Type
  extends Omit<PlanDefinition.Type, 'id' | 'url' | 'title' | 'action'>, Brand.Brand<'Plan'> {
  /** The id the plan is stored under. */
  readonly id: string
  /** The canonical url an `ExerciseRequest` names in `instantiatesCanonical`. */
  readonly url: string
  /** Human-friendly name, e.g. `"StrongLifts 5×5"`. */
  readonly title: string
  /** The workouts in cycle order. */
  readonly action: Arr.NonEmptyReadonlyArray<Workout.Type>
}

/** Whether a planned exercise plans its exercise the same way as another. */
const planSame = ({
  left,
  right,
}: {
  readonly left: PlannedExercise.Type
  readonly right: PlannedExercise.Type
}): boolean => {
  const leftRule = PlannedExercise.progressionRuleOf(left)
  const rightRule = PlannedExercise.progressionRuleOf(right)
  return (
    ExerciseConcept.nameOf(PlannedExercise.exerciseOf(left)) ===
      ExerciseConcept.nameOf(PlannedExercise.exerciseOf(right)) &&
    PlannedExercise.setsOf(left) === PlannedExercise.setsOf(right) &&
    PlannedExercise.repsOf(left) === PlannedExercise.repsOf(right) &&
    ProgressionRule.unitOf(leftRule) === ProgressionRule.unitOf(rightRule) &&
    ProgressionRule.incrementOf(leftRule) === ProgressionRule.incrementOf(rightRule) &&
    ProgressionRule.failuresBeforeDeloadOf(leftRule) ===
      ProgressionRule.failuresBeforeDeloadOf(rightRule) &&
    ProgressionRule.deloadFractionOf(leftRule) === ProgressionRule.deloadFractionOf(rightRule) &&
    ProgressionRule.minimumLoadOf(leftRule) === ProgressionRule.minimumLoadOf(rightRule) &&
    ProgressionRule.loadStepOf(leftRule) === ProgressionRule.loadStepOf(rightRule)
  )
}

/** The narrowed fields, before the checks across workouts. */
const NarrowedPlanDefinition = narrowFields(
  Schema.typeSchema(withMandatoryId(PlanDefinition.Schema)),
  {
    url: Schema.String,
    title: NonBlankString,
    action: Schema.NonEmptyArray(Schema.typeSchema(Workout.Schema)),
  }
)

/**
 * Decodes a `PlanDefinition` into a {@link Type} — fails, naming the field, on
 * no `id` or `url`, a blank `title`, no workout, a workout that does not
 * decode, two workouts with one label, or one exercise planned two ways.
 */
const PlanSchema: Schema.Schema<Type, PlanDefinition.Type> = narrowedFrom<PlanDefinition.Type>()(
  NarrowedPlanDefinition.pipe(
    Schema.filter((plan) => {
      const labelled = plan.action.map(
        (workout, index) => [Workout.labelOf(workout), index] as const
      )
      const planned = plan.action.flatMap((workout, workoutIndex) =>
        Workout.plannedExercisesOf(workout).map(
          (exercise, index) => [exercise, ['action', workoutIndex, 'action', index]] as const
        )
      )
      return [
        ...labelled
          .filter(([label], at) => labelled.findIndex(([other]) => other === label) !== at)
          .map(([label, index]) => ({
            path: ['action', index, 'title'],
            message: `expected a label no other workout has, actual ${JSON.stringify(label)}`,
          })),
        ...planned
          .filter(([exercise], at) => {
            const first = planned.find(
              ([other]) =>
                PlannedExercise.exerciseIdOf(other) === PlannedExercise.exerciseIdOf(exercise)
            )
            return (
              first !== undefined &&
              planned.indexOf(first) !== at &&
              !planSame({ left: first[0], right: exercise })
            )
          })
          .map(([exercise, path]) => ({
            path,
            message: `expected "${PlannedExercise.exerciseIdOf(exercise)}" planned as in its first workout`,
          })),
      ]
    }),
    Schema.brand('Plan')
  )
)

/** A decoded `PlanDefinition` with every optional slot empty, for a plan to be spread onto. */
const emptyPlanDefinition: PlanDefinition.Type = Schema.decodeSync(PlanDefinition.Schema)({
  resourceType: 'PlanDefinition',
  status: 'active',
})

/**
 * The plan `title`, stored under `planDefinitionId`, cycling through
 * `workouts` in order: `active`, filed under the `strength-training` feature
 * `topic`, its canonical `url` under `WILDFLOWER_CANONICAL_BASE`.
 *
 * @returns The plan; or a `ParseError` naming every problem: a blank title,
 *   no workouts, two workouts with one label, or one exercise planned two ways
 */
const make = (plan: {
  readonly planDefinitionId: string
  readonly title: string
  readonly workouts: readonly Workout.Type[]
}): Either.Either<Type, ParseResult.ParseError> =>
  Schema.decodeEither(PlanSchema, { errors: 'all' })({
    ...emptyPlanDefinition,
    id: plan.planDefinitionId,
    url: `${WILDFLOWER_CANONICAL_BASE}/PlanDefinition/${plan.planDefinitionId}`,
    status: 'active',
    title: plan.title,
    topic: [liftingFeatureConcept],
    action: plan.workouts,
  })

/** The workouts in cycle order. */
const workoutsOf = (plan: Type): Arr.NonEmptyReadonlyArray<Workout.Type> => plan.action

/** Each exercise the plan runs, once, in the order the workouts first run it. */
const plannedExercisesOf = (plan: Type): readonly PlannedExercise.Type[] =>
  Arr.dedupeWith(
    plan.action.flatMap(Workout.plannedExercisesOf),
    (left, right) => PlannedExercise.exerciseIdOf(left) === PlannedExercise.exerciseIdOf(right)
  )

/** How the plan runs the exercise `exerciseId`; `None` when it does not run it. */
const plannedExerciseOf = (plan: Type, exerciseId: string): Option.Option<PlannedExercise.Type> =>
  Arr.findFirst(
    plan.action.flatMap(Workout.plannedExercisesOf),
    (planned) => PlannedExercise.exerciseIdOf(planned) === exerciseId
  )

/**
 * The workout due next: the one after the most recent set's workout, in the
 * plan's cycle order.
 *
 * @param plan - The plan whose workouts cycle
 * @param setObservations - Every set logged under the plan, at any exercise, in any order
 * @returns One of the plan's workouts: the one after the most recent set's
 *   workout label, wrapping from the last back to the first
 *
 * @remarks
 * With no sets — or when the most recent set's label names no workout in the
 * plan, as after the plan's workouts were replaced — the cycle starts over at
 * the first workout.
 */
const nextWorkout = (
  plan: Type,
  setObservations: readonly ExerciseSetObservation.Type[]
): Workout.Type =>
  pipe(
    Arr.last(ExerciseSetObservation.sortByStart(setObservations)),
    Option.flatMap((latest) =>
      Arr.findFirstIndex(
        plan.action,
        (workout) => Workout.labelOf(workout) === ExerciseSetObservation.workoutLabelOf(latest)
      )
    ),
    Option.flatMap((index) => Arr.get(plan.action, (index + 1) % plan.action.length)),
    Option.getOrElse(() => Arr.headNonEmpty(plan.action))
  )

export {
  make,
  nextWorkout,
  plannedExerciseOf,
  plannedExercisesOf,
  PlanSchema as Schema,
  workoutsOf,
}
export type { Type }
