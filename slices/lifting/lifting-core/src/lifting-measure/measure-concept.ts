import { Array as Arr, Option, pipe, Schema } from 'effect'
import {
  CodeableConcept,
  Extension,
  WildflowerCodeSystem,
  WildflowerExtension,
} from 'fhir-r4/data-types'

import { guaranteed, onlyOneIssues } from '../internal/issues.ts'
import * as Load from '../load/load.ts'
import * as LiftingMeasure from './lifting-measure.ts'

/** A measure counted in whole sets or reps. */
type CountMeasure = typeof LiftingMeasure.Code.Sets | typeof LiftingMeasure.Code.Reps

/** Whether a concept is coded as `measure` — the one coding it has in the lifting-measure system. */
const measures =
  (measure: LiftingMeasure.Measure) =>
  (concept: CodeableConcept.Type): boolean =>
    pipe(
      CodeableConcept.onlyCodingIn(concept, WildflowerCodeSystem.LiftingMeasure),
      Option.exists((coding) => coding.code === measure)
    )

/** A measure's (already decoded) value extension carrying a load as its `valueQuantity`. */
const LoadValueSchema = Schema.Struct({ valueQuantity: Schema.typeSchema(Load.Schema) })

/** A measure's (already decoded) value extension carrying a positive count as its `valueInteger`. */
const CountValueSchema = Schema.Struct({ valueInteger: Schema.Int.pipe(Schema.positive()) })

/** A concept measuring `measure` whose one value extension satisfies `value`. */
const measureSchema = (
  measure: LiftingMeasure.Measure,
  value: Schema.Schema.AnyNoContext
): Schema.Schema<CodeableConcept.Type> =>
  Schema.typeSchema(CodeableConcept.Schema).pipe(
    Schema.filter(measures(measure)),
    Schema.filter((concept) =>
      onlyOneIssues({
        items: concept.extension,
        selected: Extension.hasUrl(WildflowerExtension.LiftingMeasureValue),
        schema: value,
        path: ['extension'],
        expected: `${WildflowerExtension.LiftingMeasureValue} extension`,
      })
    )
  )

/** Each measure's concept, its value a {@link Load.Type} for a load and a positive integer for a count. */
const MEASURE_SCHEMAS: {
  readonly [Measure in LiftingMeasure.Measure]: Schema.Schema<CodeableConcept.Type>
} = {
  load: measureSchema(LiftingMeasure.Code.Load, LoadValueSchema),
  sets: measureSchema(LiftingMeasure.Code.Sets, CountValueSchema),
  reps: measureSchema(LiftingMeasure.Code.Reps, CountValueSchema),
}

/** A value extension as {@link LoadValueSchema} reads it. */
const loadValueOf = Schema.validateOption(LoadValueSchema)

/** A value extension as {@link CountValueSchema} reads it. */
const countValueOf = Schema.validateOption(CountValueSchema)

/**
 * The issues of a list of concepts that must measure `measure` exactly once,
 * with a value of the right shape and range; `path` is where the list is.
 */
const measureIssues = (spec: {
  readonly concepts: readonly CodeableConcept.Type[]
  readonly measure: LiftingMeasure.Measure
  readonly path: readonly PropertyKey[]
}): readonly Schema.FilterIssue[] =>
  onlyOneIssues({
    items: spec.concepts,
    selected: measures(spec.measure),
    schema: MEASURE_SCHEMAS[spec.measure],
    path: spec.path,
    expected: `concept measuring "${spec.measure}"`,
  })

/**
 * The value extension of the concept among `concepts` measuring `measure` —
 * on a value whose schema checked with {@link measureIssues} that there is
 * exactly one of each.
 */
const valueExtensionAmong = (
  concepts: readonly CodeableConcept.Type[],
  measure: LiftingMeasure.Measure
): Option.Option<Extension.Type> =>
  pipe(
    Arr.findFirst(concepts, measures(measure)),
    Option.flatMap((concept) =>
      Extension.onlyAt(concept.extension, WildflowerExtension.LiftingMeasureValue)
    )
  )

/**
 * The load the one `load` concept among `concepts` carries, on a value whose
 * schema checked it with {@link measureIssues}.
 */
const loadAmong = (concepts: readonly CodeableConcept.Type[]): Load.Type =>
  guaranteed(
    pipe(
      valueExtensionAmong(concepts, LiftingMeasure.Code.Load),
      Option.flatMap(loadValueOf),
      Option.map((extension) => extension.valueQuantity)
    )
  )

/**
 * The count the one `measure` concept among `concepts` carries, on a value
 * whose schema checked it with {@link measureIssues}.
 */
const countAmong = (concepts: readonly CodeableConcept.Type[], measure: CountMeasure): number =>
  guaranteed(
    pipe(
      valueExtensionAmong(concepts, measure),
      Option.flatMap(countValueOf),
      Option.map((extension) => extension.valueInteger)
    )
  )

/** A `measure` concept carrying `value` spread onto its value extension. */
const measureConcept = (
  measure: LiftingMeasure.Measure,
  value: Partial<Extension.Type>
): CodeableConcept.Type => ({
  ...CodeableConcept.make({
    system: WildflowerCodeSystem.LiftingMeasure,
    code: measure,
    display: null,
    text: null,
  }),
  extension: [{ ...Extension.emptyAt(WildflowerExtension.LiftingMeasureValue), ...value }],
})

/** The `load` concept carrying `load` as its `valueQuantity`. */
const loadConcept = (load: Load.Type): CodeableConcept.Type =>
  measureConcept(LiftingMeasure.Code.Load, { valueQuantity: load })

/** A `sets` or `reps` concept carrying `count` as its `valueInteger`. */
const countConcept = (count: {
  readonly measure: CountMeasure
  readonly value: number
}): CodeableConcept.Type => measureConcept(count.measure, { valueInteger: count.value })

export { countAmong, countConcept, loadAmong, loadConcept, measureIssues, measures }
export type { CountMeasure }
