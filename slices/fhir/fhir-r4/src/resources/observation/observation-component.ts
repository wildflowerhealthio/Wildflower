import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import {
  filterForExclusiveChoiceElementSet,
  choiceElementSetPassthroughFields,
} from '../../data-types/base/choice-element-passthrough-fields.ts'
import * as ChoiceElementSet from '../../data-types/base/choice-element-set.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as ObservationReferenceRange from './observation-reference-range.ts'

const ObservationComponentStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    code: Schema.suspend(() => CodeableConcept.Schema),
    dataAbsentReason: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    interpretation: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
      { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
    ),
    referenceRange: Schema.optionalWith(
      mutableEncoded(Schema.Array(ObservationReferenceRange.Schema)),
      { default: (): readonly (typeof ObservationReferenceRange.Schema.Type)[] => [] }
    ),
    ...choiceElementSetPassthroughFields(
      'value',
      ChoiceElementSet.FhirR4SetChoices['Observation.component.value[x]']
    ),
  })
).pipe(
  filterForExclusiveChoiceElementSet(
    'value',
    ChoiceElementSet.FhirR4SetChoices['Observation.component.value[x]']
  )
)

const ObservationComponentSchema: Schema.Schema<
  typeof ObservationComponentStruct.Type,
  FhirR4.ObservationComponent,
  never
> = ObservationComponentStruct

export { ObservationComponentSchema as Schema }
