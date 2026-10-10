import { type Arbitrary, type FastCheck, Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import {
  filterForExclusiveChoiceElementSet,
  choiceElementSetPassthroughFields,
} from '../../data-types/base/choice-element-passthrough-fields.ts'
import * as ChoiceElementSet from '../../data-types/base/choice-element-set.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'

/** FHIR R4 value set for `PlanDefinition.action.priority` (`request-priority`). */
const PrioritySchema = Schema.Literal('routine', 'urgent', 'asap', 'stat')

/** FHIR R4 value set for `PlanDefinition.action.groupingBehavior` (`action-grouping-behavior`). */
const GroupingBehaviorSchema = Schema.Literal('visual-group', 'logical-group', 'sentence-group')

/** FHIR R4 value set for `PlanDefinition.action.selectionBehavior` (`action-selection-behavior`). */
const SelectionBehaviorSchema = Schema.Literal(
  'any',
  'all',
  'all-or-none',
  'exactly-one',
  'at-most-one',
  'one-or-more'
)

/** FHIR R4 value set for `PlanDefinition.action.requiredBehavior` (`action-required-behavior`). */
const RequiredBehaviorSchema = Schema.Literal('must', 'could', 'must-unless-documented')

/** FHIR R4 value set for `PlanDefinition.action.precheckBehavior` (`action-precheck-behavior`). */
const PrecheckBehaviorSchema = Schema.Literal('yes', 'no')

/** FHIR R4 value set for `PlanDefinition.action.cardinalityBehavior` (`action-cardinality-behavior`). */
const CardinalityBehaviorSchema = Schema.Literal('single', 'multiple')

const codeableConceptArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
  { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
)

const passthroughArray = Schema.optionalWith(mutableEncoded(Schema.Array(Schema.Any)), {
  default: (): readonly unknown[] => [],
})

// Every field but the recursive `action` array, which needs the explicit
// `PlanDefinitionActionType` below to type its self-reference.
const nonRecursiveFields = {
  ...BackboneElement.fields,
  prefix: OrNullAsOptional(Schema.String),
  title: OrNullAsOptional(Schema.String),
  description: OrNullAsOptional(Schema.String),
  textEquivalent: OrNullAsOptional(Schema.String),
  priority: OrNullAsOptional(PrioritySchema),
  code: codeableConceptArray,
  reason: codeableConceptArray,
  documentation: passthroughArray,
  goalId: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
    default: (): readonly string[] => [],
  }),
  ...choiceElementSetPassthroughFields(
    'subject',
    ChoiceElementSet.FhirR4SetChoices['PlanDefinition.action.subject[x]']
  ),
  trigger: passthroughArray,
  condition: passthroughArray,
  input: passthroughArray,
  output: passthroughArray,
  relatedAction: passthroughArray,
  ...choiceElementSetPassthroughFields(
    'timing',
    ChoiceElementSet.FhirR4SetChoices['PlanDefinition.action.timing[x]']
  ),
  participant: passthroughArray,
  type: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
  groupingBehavior: OrNullAsOptional(GroupingBehaviorSchema),
  selectionBehavior: OrNullAsOptional(SelectionBehaviorSchema),
  requiredBehavior: OrNullAsOptional(RequiredBehaviorSchema),
  precheckBehavior: OrNullAsOptional(PrecheckBehaviorSchema),
  cardinalityBehavior: OrNullAsOptional(CardinalityBehaviorSchema),
  ...choiceElementSetPassthroughFields(
    'definition',
    ChoiceElementSet.FhirR4SetChoices['PlanDefinition.action.definition[x]']
  ),
  transform: OrNullAsOptional(Schema.String),
  dynamicValue: passthroughArray,
}

/**
 * Decoded shape of {@link PlanDefinitionActionSchema}. Written out explicitly
 * (rather than inferred) because the schema is recursive through the nested
 * `action` array — TypeScript cannot infer a type for a self-referential
 * schema constant.
 */
interface PlanDefinitionActionType extends Schema.Struct.Type<typeof nonRecursiveFields> {
  readonly action: readonly PlanDefinitionActionType[]
}

/**
 * Wire schema for FHIR R4 `PlanDefinition.action` — one step of a plan
 * definition, optionally grouping further sub-actions under its own `action`.
 *
 * @remarks
 * `subject[x]`, `timing[x]` and `definition[x]` each allow at most one
 * populated slot. `documentation`, `trigger`, `condition`, `input`, `output`,
 * `relatedAction`, `participant` and `dynamicValue` pass through untyped —
 * see "PlanDefinition choice / required / backbone modeling" in
 * `fhir-r4/docs/Client Capabilities Reference.md`.
 */
const PlanDefinitionActionSchema: Schema.Schema<
  PlanDefinitionActionType,
  FhirR4.PlanDefinitionAction,
  never
> = mutableEncoded(
  StructNoContext({
    ...nonRecursiveFields,
    // Override `Arbitrary.make(...)` to always emit `[]`: each nested action
    // carries the whole field set again, so unbounded recursion makes property
    // tests intractable. Nesting is exercised by explicit fixtures.
    action: Schema.optionalWith(
      mutableEncoded(
        Schema.Array(Schema.suspend(() => PlanDefinitionActionSchema)).annotations({
          arbitrary:
            (): Arbitrary.LazyArbitrary<readonly PlanDefinitionActionType[]> =>
            (fc: typeof FastCheck) =>
              fc.constant([]),
        })
      ),
      { default: (): readonly PlanDefinitionActionType[] => [] }
    ),
  })
).pipe(
  filterForExclusiveChoiceElementSet(
    'subject',
    ChoiceElementSet.FhirR4SetChoices['PlanDefinition.action.subject[x]']
  ),
  filterForExclusiveChoiceElementSet(
    'timing',
    ChoiceElementSet.FhirR4SetChoices['PlanDefinition.action.timing[x]']
  ),
  filterForExclusiveChoiceElementSet(
    'definition',
    ChoiceElementSet.FhirR4SetChoices['PlanDefinition.action.definition[x]']
  )
)

export {
  PlanDefinitionActionSchema as Schema,
  PrioritySchema,
  GroupingBehaviorSchema,
  SelectionBehaviorSchema,
  RequiredBehaviorSchema,
  PrecheckBehaviorSchema,
  CardinalityBehaviorSchema,
  type PlanDefinitionActionType as Type,
}
