import { Schema } from 'effect'

import {
  OrNullAsOptional,
  StructNoContext,
  mutableEncoded,
} from '@wildflowerhealthio/kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import {
  filterForExclusiveChoiceElementSet,
  choiceElementSetPassthroughFields,
} from '../../data-types/base/choice-element-passthrough-fields.ts'
import * as ChoiceElementSet from '../../data-types/base/choice-element-set.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'

const GoalTargetStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    measure: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    ...choiceElementSetPassthroughFields(
      'detail',
      ChoiceElementSet.FhirR4SetChoices['Goal.target.detail[x]']
    ),
    ...choiceElementSetPassthroughFields(
      'due',
      ChoiceElementSet.FhirR4SetChoices['Goal.target.due[x]']
    ),
  })
).pipe(
  filterForExclusiveChoiceElementSet(
    'detail',
    ChoiceElementSet.FhirR4SetChoices['Goal.target.detail[x]']
  ),
  filterForExclusiveChoiceElementSet('due', ChoiceElementSet.FhirR4SetChoices['Goal.target.due[x]'])
)

/**
 * Wire schema for FHIR R4 `Goal.target` — the measure a goal is judged by, the
 * value it should reach (`detail[x]`) and when it is due (`due[x]`).
 *
 * @remarks
 * `detail[x]` and `due[x]` each allow at most one populated slot.
 */
const GoalTargetSchema: Schema.Schema<typeof GoalTargetStruct.Type, FhirR4.GoalTarget, never> =
  GoalTargetStruct

export { GoalTargetSchema as Schema }
