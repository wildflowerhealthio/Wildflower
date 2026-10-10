import {
  CodeableConcept,
  Coding,
  Extension,
  narrowFields,
  WildflowerCodeSystem,
  WildflowerExtension,
} from '@wildflowerhealthio/fhir-r4/data-types'
import { PlanDefinitionAction } from '@wildflowerhealthio/fhir-r4/resources'
import {
  Array as Arr,
  type Brand,
  type Either,
  Option,
  type ParseResult,
  pipe,
  Schema,
} from 'effect'

import {
  countExerciseParameterAmong,
  countExerciseParameterConcept,
  checkArrayHasOneExerciseParameter,
} from '../exercise-parameter/exercise-parameter-concept.ts'
import * as ExerciseParameter from '../exercise-parameter/exercise-parameter.ts'
import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import { checkArrayHasOneMatchingElement } from '../internal/check-array-has-one-matching-element.ts'
import { filterArrayWithEveryCheck } from '../internal/filter-array-with-every-check.ts'
import { guaranteed } from '../internal/guaranteed.ts'
import { narrowedFrom } from '../internal/narrowed-from.ts'
import * as TrainingPlanDefinitionProgressionRule from './progression-rule.ts'

/** Whether a concept is coded in the exercise system at all — a candidate for the action's exercise concept. */
const namesAnExercise = (concept: CodeableConcept.Type): boolean =>
  concept.coding.some(Coding.isInSystem(WildflowerCodeSystem.Exercise))

/** An exercise concept's type, for the action's one exercise code to satisfy. */
const ExerciseConceptType = Schema.typeSchema(ExerciseConcept.Schema)

/** A progression rule's type, for the action's one rule extension to satisfy. */
const TrainingPlanDefinitionProgressionRuleType = Schema.typeSchema(
  TrainingPlanDefinitionProgressionRule.Schema
)

/** Whether a code is a well-formed exercise concept. */
const isExerciseConcept = Schema.is(ExerciseConcept.Schema)

/** Whether an extension is a well-formed progression rule. */
const isTrainingPlanDefinitionProgressionRule = Schema.is(
  TrainingPlanDefinitionProgressionRule.Schema
)

/**
 * One exercise (definition) of a training plan definition's day — how the
 * training plan definition runs it — as FHIR carries it: a nested
 * `PlanDefinition.action` narrowed to exactly one {@link ExerciseConcept.Type}
 * among its `code`s, one `sets` and one `reps` exercise parameter concept
 * (each a positive integer in its value extension), and exactly one
 * {@link TrainingPlanDefinitionProgressionRule.Type} among its extensions —
 * `sets` × `reps` each workout, the load moved by the rule.
 *
 * @remarks
 * The load itself is not here: it is the lifter's, on their current
 * `ExerciseRequest`. Other codes and extensions ride along untouched.
 */
interface TrainingPlanDefinitionExercise
  extends PlanDefinitionAction.Type, Brand.Brand<'TrainingPlanDefinitionExercise'> {}

/**
 * Decodes a `PlanDefinition.action` into a
 * {@link TrainingPlanDefinitionExercise} — fails, naming the code or
 * extension, on a missing or repeated exercise concept, exercise parameter or
 * rule, or one that is malformed or out of range.
 */
const TrainingPlanDefinitionExerciseSchema: Schema.Schema<
  TrainingPlanDefinitionExercise,
  PlanDefinitionAction.Type
> = narrowedFrom<PlanDefinitionAction.Type>()(
  narrowFields(Schema.typeSchema(PlanDefinitionAction.Schema), {
    code: Schema.Array(Schema.typeSchema(CodeableConcept.Schema)).pipe(
      filterArrayWithEveryCheck([
        checkArrayHasOneMatchingElement({
          matches: namesAnExercise,
          schema: ExerciseConceptType,
          expected: 'exercise concept',
        }),
        checkArrayHasOneExerciseParameter(ExerciseParameter.Code.Sets),
        checkArrayHasOneExerciseParameter(ExerciseParameter.Code.Reps),
      ])
    ),
    extension: Schema.Array(Schema.typeSchema(Extension.Schema)).pipe(
      Schema.filter(
        checkArrayHasOneMatchingElement({
          matches: Extension.hasUrl(WildflowerExtension.LiftingProgression),
          schema: TrainingPlanDefinitionProgressionRuleType,
          expected: `${WildflowerExtension.LiftingProgression} extension`,
        })
      )
    ),
  }).pipe(Schema.brand('TrainingPlanDefinitionExercise'))
)

/** A decoded `PlanDefinition.action` with every optional slot empty, for an exercise (definition) to be spread onto. */
const emptyAction: PlanDefinitionAction.Type = Schema.decodeSync(PlanDefinitionAction.Schema)({})

/**
 * The exercise (definition) running `exerciseConcept`: `sets` × `reps` each
 * workout, its load moved by `progressionRule`.
 *
 * @returns The exercise (definition); or a `ParseError` when `sets` or `reps`
 *   is not a positive integer
 */
const make = (trainingPlanDefinitionExercise: {
  readonly exerciseConcept: ExerciseConcept.Type
  readonly sets: number
  readonly reps: number
  readonly progressionRule: TrainingPlanDefinitionProgressionRule.Type
}): Either.Either<TrainingPlanDefinitionExercise, ParseResult.ParseError> =>
  Schema.decodeEither(TrainingPlanDefinitionExerciseSchema, { errors: 'all' })({
    ...emptyAction,
    code: [
      trainingPlanDefinitionExercise.exerciseConcept,
      countExerciseParameterConcept({
        code: ExerciseParameter.Code.Sets,
        value: trainingPlanDefinitionExercise.sets,
      }),
      countExerciseParameterConcept({
        code: ExerciseParameter.Code.Reps,
        value: trainingPlanDefinitionExercise.reps,
      }),
    ],
    extension: [trainingPlanDefinitionExercise.progressionRule],
  })

/** The exercise concept the action runs. */
const exerciseConceptOf = (
  trainingPlanDefinitionExercise: TrainingPlanDefinitionExercise
): ExerciseConcept.Type =>
  guaranteed(
    pipe(
      Arr.findFirst(trainingPlanDefinitionExercise.code, namesAnExercise),
      Option.filter(isExerciseConcept)
    )
  )

/** The id of the exercise concept the action runs. */
const exerciseIdOf = (trainingPlanDefinitionExercise: TrainingPlanDefinitionExercise): string =>
  ExerciseConcept.idOf(exerciseConceptOf(trainingPlanDefinitionExercise))

/** Sets to perform each workout; a positive integer. */
const setsOf = (trainingPlanDefinitionExercise: TrainingPlanDefinitionExercise): number =>
  countExerciseParameterAmong(trainingPlanDefinitionExercise.code, ExerciseParameter.Code.Sets)

/** Reps per set; a positive integer. */
const repsOf = (trainingPlanDefinitionExercise: TrainingPlanDefinitionExercise): number =>
  countExerciseParameterAmong(trainingPlanDefinitionExercise.code, ExerciseParameter.Code.Reps)

/** How the exercise's load moves after each workout. */
const progressionRuleOf = (
  trainingPlanDefinitionExercise: TrainingPlanDefinitionExercise
): TrainingPlanDefinitionProgressionRule.Type =>
  guaranteed(
    pipe(
      Extension.onlyAt(
        trainingPlanDefinitionExercise.extension,
        WildflowerExtension.LiftingProgression
      ),
      Option.filter(isTrainingPlanDefinitionProgressionRule)
    )
  )

export {
  exerciseConceptOf,
  exerciseIdOf,
  make,
  TrainingPlanDefinitionExerciseSchema as Schema,
  progressionRuleOf,
  repsOf,
  setsOf,
}
export type { TrainingPlanDefinitionExercise as Type }
