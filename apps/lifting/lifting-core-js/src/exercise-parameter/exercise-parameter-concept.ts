import { Array as Arr, Option, pipe, Schema } from 'effect'
import {
  CodeableConcept,
  Extension,
  WildflowerCodeSystem,
  WildflowerExtension,
} from 'fhir-r4/data-types'

import { checkArrayHasOneMatchingElement } from '../internal/check-array-has-one-matching-element.ts'
import type { ArrayElementsCheck } from '../internal/filter-array-with-every-check.ts'
import { guaranteed } from '../internal/guaranteed.ts'
import * as Load from '../load/load.ts'
import * as ExerciseParameter from './exercise-parameter.ts'

/** An exercise parameter counted in whole sets or reps. */
type CountExerciseParameterCode =
  | typeof ExerciseParameter.Code.Sets
  | typeof ExerciseParameter.Code.Reps

/** Whether a concept is coded as the exercise parameter `code` — the one coding it has in the exercise parameter system. */
const isExerciseParameterConcept =
  (code: ExerciseParameter.Code) =>
  (concept: CodeableConcept.Type): boolean =>
    pipe(
      CodeableConcept.onlyCodingIn(concept, WildflowerCodeSystem.ExerciseParameter),
      Option.exists((coding) => coding.code === code)
    )

/** An exercise parameter's (already decoded) value extension carrying a load as its `valueQuantity`. */
const LoadValueSchema = Schema.Struct({ valueQuantity: Schema.typeSchema(Load.Schema) })

/** An exercise parameter's (already decoded) value extension carrying a positive count as its `valueInteger`. */
const CountValueSchema = Schema.Struct({ valueInteger: Schema.Int.pipe(Schema.positive()) })

/**
 * What an (already decoded) concept coded as an exercise parameter must
 * carry: exactly one `ExerciseParameterValue` extension, satisfying `value`.
 */
const exerciseParameterValueConceptSchema = (
  value: Schema.Schema.AnyNoContext
): Schema.Schema.AnyNoContext =>
  Schema.Struct({
    extension: Schema.Array(Schema.typeSchema(Extension.Schema)).pipe(
      Schema.filter(
        checkArrayHasOneMatchingElement({
          matches: Extension.hasUrl(WildflowerExtension.ExerciseParameterValue),
          schema: value,
          expected: `${WildflowerExtension.ExerciseParameterValue} extension`,
        })
      )
    ),
  })

/** What each exercise parameter's concept must carry: a {@link Load.Type} for a load, a positive integer for a count. */
const EXERCISE_PARAMETER_VALUE_CONCEPT_SCHEMAS: {
  readonly [Code in ExerciseParameter.Code]: Schema.Schema.AnyNoContext
} = {
  load: exerciseParameterValueConceptSchema(LoadValueSchema),
  sets: exerciseParameterValueConceptSchema(CountValueSchema),
  reps: exerciseParameterValueConceptSchema(CountValueSchema),
}

/** A value extension as {@link LoadValueSchema} reads it. */
const loadValueOf = Schema.validateOption(LoadValueSchema)

/** A value extension as {@link CountValueSchema} reads it. */
const countValueOf = Schema.validateOption(CountValueSchema)

/**
 * Checks a list of concepts holds exactly one coded as the exercise parameter
 * `code`, with a value of the right shape and range.
 */
const checkArrayHasOneExerciseParameter = (
  code: ExerciseParameter.Code
): ArrayElementsCheck<CodeableConcept.Type> =>
  checkArrayHasOneMatchingElement({
    matches: isExerciseParameterConcept(code),
    schema: EXERCISE_PARAMETER_VALUE_CONCEPT_SCHEMAS[code],
    expected: `concept coded as the exercise parameter "${code}"`,
  })

/**
 * The value extension of the concept among `concepts` coded as the exercise
 * parameter `code` — on a value whose schema checked with
 * {@link checkArrayHasOneExerciseParameter} that there is exactly one of each.
 */
const exerciseParameterValueExtensionAmong = (
  concepts: readonly CodeableConcept.Type[],
  code: ExerciseParameter.Code
): Option.Option<Extension.Type> =>
  pipe(
    Arr.findFirst(concepts, isExerciseParameterConcept(code)),
    Option.flatMap((concept) =>
      Extension.onlyAt(concept.extension, WildflowerExtension.ExerciseParameterValue)
    )
  )

/**
 * The load the one `load` exercise parameter among `concepts` carries, on a
 * value whose schema checked it with {@link checkArrayHasOneExerciseParameter}.
 */
const loadExerciseParameterAmong = (concepts: readonly CodeableConcept.Type[]): Load.Type =>
  guaranteed(
    pipe(
      exerciseParameterValueExtensionAmong(concepts, ExerciseParameter.Code.Load),
      Option.flatMap(loadValueOf),
      Option.map((extension) => extension.valueQuantity)
    )
  )

/**
 * The count the one `code` exercise parameter among `concepts` carries, on a
 * value whose schema checked it with {@link checkArrayHasOneExerciseParameter}.
 */
const countExerciseParameterAmong = (
  concepts: readonly CodeableConcept.Type[],
  code: CountExerciseParameterCode
): number =>
  guaranteed(
    pipe(
      exerciseParameterValueExtensionAmong(concepts, code),
      Option.flatMap(countValueOf),
      Option.map((extension) => extension.valueInteger)
    )
  )

/** A concept coded as the exercise parameter `code`, carrying `value` spread onto its value extension. */
const exerciseParameterConcept = (
  code: ExerciseParameter.Code,
  value: Partial<Extension.Type>
): CodeableConcept.Type => ({
  ...CodeableConcept.make({
    system: WildflowerCodeSystem.ExerciseParameter,
    code,
    display: null,
    text: null,
  }),
  extension: [{ ...Extension.emptyAt(WildflowerExtension.ExerciseParameterValue), ...value }],
})

/** The `load` exercise parameter concept carrying `load` as its `valueQuantity`. */
const loadExerciseParameterConcept = (load: Load.Type): CodeableConcept.Type =>
  exerciseParameterConcept(ExerciseParameter.Code.Load, { valueQuantity: load })

/** A `sets` or `reps` exercise parameter concept carrying `value` as its `valueInteger`. */
const countExerciseParameterConcept = (count: {
  readonly code: CountExerciseParameterCode
  readonly value: number
}): CodeableConcept.Type => exerciseParameterConcept(count.code, { valueInteger: count.value })

export {
  countExerciseParameterAmong,
  countExerciseParameterConcept,
  checkArrayHasOneExerciseParameter,
  isExerciseParameterConcept,
  loadExerciseParameterAmong,
  loadExerciseParameterConcept,
}
export type { CountExerciseParameterCode }
