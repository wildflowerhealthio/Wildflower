import { Schema } from 'effect'

import type { Observation as StoreObservation } from 'emr-core/livestore'
import { ChoiceElementSet } from 'emr-core/schemas'
import { StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import { choiceElementSetPassthroughFields } from '../../data-types/base/choice-element-passthrough-fields.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as ObservationReferenceRange from './observation-reference-range.ts'

const ObservationComponentSchema: Schema.Schema<
  typeof StoreObservation.Component.Schema.Type,
  FhirR4.ObservationComponent,
  never
> = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    code: Schema.suspend(() => CodeableConcept.Schema),
    dataAbsentReason: Schema.optional(Schema.suspend(() => CodeableConcept.Schema)),
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
)

export { ObservationComponentSchema as Schema }
