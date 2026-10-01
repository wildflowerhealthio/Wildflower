import { type Array as Arr, type Brand, type Either, type ParseResult, Schema } from 'effect'
import { narrowFields } from 'fhir-r4/data-types'
import { PlanDefinitionAction } from 'fhir-r4/resources'

import { narrowedFrom } from '../internal/narrowed-from.ts'
import * as TrainingPlanDefinitionExercise from './exercise.ts'

/**
 * One day of a training plan definition's cycle, as FHIR carries it: a
 * `PlanDefinition.action` narrowed to a non-empty, trimmed `title` — its label
 * (StrongLifts has `"A"` and `"B"`) — and at least one nested `action`, each
 * an exercise (definition), a {@link TrainingPlanDefinitionExercise.Type}, in
 * the order they are performed.
 */
interface TrainingPlanDefinitionDay
  extends
    Omit<PlanDefinitionAction.Type, 'title' | 'action'>,
    Brand.Brand<'TrainingPlanDefinitionDay'> {
  /** The label that identifies this day within its training plan definition's cycle. */
  readonly title: string
  /** The exercises (definitions) performed, in order. */
  readonly action: Arr.NonEmptyReadonlyArray<TrainingPlanDefinitionExercise.Type>
}

/**
 * Decodes a `PlanDefinition.action` into a {@link TrainingPlanDefinitionDay} —
 * fails on a missing, empty or untrimmed `title`, no nested action, or a
 * nested action that is not an exercise (definition).
 */
const TrainingPlanDefinitionDaySchema: Schema.Schema<
  TrainingPlanDefinitionDay,
  PlanDefinitionAction.Type
> = narrowedFrom<PlanDefinitionAction.Type>()(
  narrowFields(Schema.typeSchema(PlanDefinitionAction.Schema), {
    title: Schema.NonEmptyTrimmedString,
    action: Schema.NonEmptyArray(Schema.typeSchema(TrainingPlanDefinitionExercise.Schema)),
  }).pipe(Schema.brand('TrainingPlanDefinitionDay'))
)

/** A decoded `PlanDefinition.action` with every optional slot empty, for a day to be spread onto. */
const emptyAction: PlanDefinitionAction.Type = Schema.decodeSync(PlanDefinitionAction.Schema)({})

/**
 * The day labelled `label`, running `trainingPlanDefinitionExercises` in
 * order.
 *
 * @returns The day; or a `ParseError` when `label` is empty or untrimmed, or
 *   there are no exercises (definitions)
 */
const make = (trainingPlanDefinitionDay: {
  readonly label: string
  readonly trainingPlanDefinitionExercises: readonly TrainingPlanDefinitionExercise.Type[]
}): Either.Either<TrainingPlanDefinitionDay, ParseResult.ParseError> =>
  Schema.decodeEither(TrainingPlanDefinitionDaySchema, { errors: 'all' })({
    ...emptyAction,
    title: trainingPlanDefinitionDay.label,
    action: trainingPlanDefinitionDay.trainingPlanDefinitionExercises,
  })

/** The label that identifies the day within its training plan definition's cycle. */
const labelOf = (trainingPlanDefinitionDay: TrainingPlanDefinitionDay): string =>
  trainingPlanDefinitionDay.title

/** The exercises (definitions) the day runs, in order — what the "today" screen lists. */
const exercisesOf = (
  trainingPlanDefinitionDay: TrainingPlanDefinitionDay
): Arr.NonEmptyReadonlyArray<TrainingPlanDefinitionExercise.Type> =>
  trainingPlanDefinitionDay.action

export { exercisesOf, labelOf, make, TrainingPlanDefinitionDaySchema as Schema }
export type { TrainingPlanDefinitionDay as Type }
