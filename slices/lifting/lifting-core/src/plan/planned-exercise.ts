import {
  Array as Arr,
  type Brand,
  type Either,
  Option,
  type ParseResult,
  pipe,
  Schema,
} from 'effect'
import type { CodeableConcept } from 'fhir-r4/data-types'
import { Coding, Extension, WildflowerCodeSystem, WildflowerExtension } from 'fhir-r4/data-types'
import { PlanDefinitionAction } from 'fhir-r4/resources'

import {
  countExerciseParameterAmong,
  countExerciseParameterConcept,
  exerciseParameterIssues,
} from '../exercise-parameter/exercise-parameter-concept.ts'
import * as ExerciseParameter from '../exercise-parameter/exercise-parameter.ts'
import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import { guaranteed, onlyOneIssues } from '../internal/issues.ts'
import { narrowedFrom } from '../internal/narrowed-from.ts'
import * as ProgressionRule from './progression-rule.ts'

/** Whether a concept is coded in the exercise system at all — a candidate for the action's exercise. */
const namesAnExercise = (concept: CodeableConcept.Type): boolean =>
  concept.coding.some(Coding.isInSystem(WildflowerCodeSystem.Exercise))

/** An exercise concept's type, for the action's one exercise code to satisfy. */
const ExerciseConceptType = Schema.typeSchema(ExerciseConcept.Schema)

/** A progression rule's type, for the action's one rule extension to satisfy. */
const ProgressionRuleType = Schema.typeSchema(ProgressionRule.Schema)

/** Whether a code is a well-formed exercise concept. */
const isExerciseConcept = Schema.is(ExerciseConcept.Schema)

/** Whether an extension is a well-formed progression rule. */
const isProgressionRule = Schema.is(ProgressionRule.Schema)

/**
 * How a plan runs one exercise, as FHIR carries it: a `PlanDefinition.action`
 * narrowed to exactly one {@link ExerciseConcept.Type} among its `code`s, one
 * `sets` and one `reps` exercise parameter concept (each a positive integer
 * in its value extension), and exactly one {@link ProgressionRule.Type} among its
 * extensions — `sets` × `reps` each workout, the load moved by the rule.
 *
 * @remarks
 * The load itself is not here: it is the lifter's, on their current
 * `ExerciseRequest`. Other codes and extensions ride along untouched.
 */
interface Type extends PlanDefinitionAction.Type, Brand.Brand<'PlannedExercise'> {}

/**
 * Decodes a `PlanDefinition.action` into a {@link Type} — fails, naming the
 * code or extension, on a missing or repeated exercise, exercise parameter or rule, or
 * one that is malformed or out of range.
 */
const PlannedExerciseSchema: Schema.Schema<Type, PlanDefinitionAction.Type> =
  narrowedFrom<PlanDefinitionAction.Type>()(
    Schema.typeSchema(PlanDefinitionAction.Schema).pipe(
      Schema.filter((action) => [
        ...onlyOneIssues({
          items: action.code,
          selected: namesAnExercise,
          schema: ExerciseConceptType,
          path: ['code'],
          expected: 'exercise concept',
        }),
        ...exerciseParameterIssues({
          concepts: action.code,
          code: ExerciseParameter.Code.Sets,
          path: ['code'],
        }),
        ...exerciseParameterIssues({
          concepts: action.code,
          code: ExerciseParameter.Code.Reps,
          path: ['code'],
        }),
        ...onlyOneIssues({
          items: action.extension,
          selected: Extension.hasUrl(WildflowerExtension.LiftingProgression),
          schema: ProgressionRuleType,
          path: ['extension'],
          expected: `${WildflowerExtension.LiftingProgression} extension`,
        }),
      ]),
      Schema.brand('PlannedExercise')
    )
  )

/** A decoded `PlanDefinition.action` with every optional slot empty, for a planned exercise to be spread onto. */
const emptyAction: PlanDefinitionAction.Type = Schema.decodeSync(PlanDefinitionAction.Schema)({})

/**
 * The planned `exercise`: `sets` × `reps` each workout, its load moved by
 * `progressionRule`.
 *
 * @returns The planned exercise; or a `ParseError` when `sets` or `reps` is
 *   not a positive integer
 */
const make = (planned: {
  readonly exercise: ExerciseConcept.Type
  readonly sets: number
  readonly reps: number
  readonly progressionRule: ProgressionRule.Type
}): Either.Either<Type, ParseResult.ParseError> =>
  Schema.decodeEither(PlannedExerciseSchema, { errors: 'all' })({
    ...emptyAction,
    code: [
      planned.exercise,
      countExerciseParameterConcept({ code: ExerciseParameter.Code.Sets, value: planned.sets }),
      countExerciseParameterConcept({ code: ExerciseParameter.Code.Reps, value: planned.reps }),
    ],
    extension: [planned.progressionRule],
  })

/** The exercise the action plans. */
const exerciseOf = (planned: Type): ExerciseConcept.Type =>
  guaranteed(pipe(Arr.findFirst(planned.code, namesAnExercise), Option.filter(isExerciseConcept)))

/** The id of the exercise the action plans. */
const exerciseIdOf = (planned: Type): string => ExerciseConcept.idOf(exerciseOf(planned))

/** Sets to perform each workout; a positive integer. */
const setsOf = (planned: Type): number =>
  countExerciseParameterAmong(planned.code, ExerciseParameter.Code.Sets)

/** Reps per set; a positive integer. */
const repsOf = (planned: Type): number =>
  countExerciseParameterAmong(planned.code, ExerciseParameter.Code.Reps)

/** How the exercise's load moves after each workout. */
const progressionRuleOf = (planned: Type): ProgressionRule.Type =>
  guaranteed(
    pipe(
      Extension.onlyAt(planned.extension, WildflowerExtension.LiftingProgression),
      Option.filter(isProgressionRule)
    )
  )

export {
  exerciseIdOf,
  exerciseOf,
  make,
  PlannedExerciseSchema as Schema,
  progressionRuleOf,
  repsOf,
  setsOf,
}
export type { Type }
