import { type Array as Arr, type Brand, type Either, type ParseResult, Schema } from 'effect'
import { narrowFields } from 'fhir-r4/data-types'
import { PlanDefinitionAction } from 'fhir-r4/resources'

import { narrowedFrom } from '../internal/narrowed-from.ts'
import * as PlannedExercise from './planned-exercise.ts'

/**
 * One workout of a plan's cycle, as FHIR carries it: a `PlanDefinition.action`
 * narrowed to a non-empty, trimmed `title` — its label (StrongLifts has `"A"` and
 * `"B"`) — and at least one nested `action`, each a
 * {@link PlannedExercise.Type}, in the order they are performed.
 */
interface Type extends Omit<PlanDefinitionAction.Type, 'title' | 'action'>, Brand.Brand<'Workout'> {
  /** The label that identifies this workout within its plan's cycle. */
  readonly title: string
  /** The exercises performed, in order. */
  readonly action: Arr.NonEmptyReadonlyArray<PlannedExercise.Type>
}

/**
 * Decodes a `PlanDefinition.action` into a {@link Type} — fails on a missing,
 * empty or untrimmed `title`, no nested action, or a nested action that is not a planned
 * exercise.
 */
const WorkoutSchema: Schema.Schema<Type, PlanDefinitionAction.Type> =
  narrowedFrom<PlanDefinitionAction.Type>()(
    narrowFields(Schema.typeSchema(PlanDefinitionAction.Schema), {
      title: Schema.NonEmptyTrimmedString,
      action: Schema.NonEmptyArray(Schema.typeSchema(PlannedExercise.Schema)),
    }).pipe(Schema.brand('Workout'))
  )

/** A decoded `PlanDefinition.action` with every optional slot empty, for a workout to be spread onto. */
const emptyAction: PlanDefinitionAction.Type = Schema.decodeSync(PlanDefinitionAction.Schema)({})

/**
 * The workout labelled `label`, running `plannedExercises` in order.
 *
 * @returns The workout; or a `ParseError` when `label` is empty or untrimmed, or there are
 *   no planned exercises
 */
const make = (workout: {
  readonly label: string
  readonly plannedExercises: readonly PlannedExercise.Type[]
}): Either.Either<Type, ParseResult.ParseError> =>
  Schema.decodeEither(WorkoutSchema, { errors: 'all' })({
    ...emptyAction,
    title: workout.label,
    action: workout.plannedExercises,
  })

/** The label that identifies the workout within its plan's cycle. */
const labelOf = (workout: Type): string => workout.title

/** The exercises the workout runs, in order — what the "today" screen lists. */
const plannedExercisesOf = (workout: Type): Arr.NonEmptyReadonlyArray<PlannedExercise.Type> =>
  workout.action

export { labelOf, make, plannedExercisesOf, WorkoutSchema as Schema }
export type { Type }
