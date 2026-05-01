import { Schema } from 'effect'

import {
  AnnotateArrayWithArbitrary,
  StructNoContext,
  type FieldsNoContext,
} from 'kitchen-sink/schema'
import { Schema as BackboneElementSchema } from '../schemas/base/backbone-element.ts'
import * as CodeableConcept from '../schemas/complex/codeable-concept.ts'
import * as DatatypeChoice from '../schemas/datatype-choice.ts'
import FhirR4ChoiceElements from '../schemas/fhir-r4-choice-elements.ts'
import * as ObservationReferenceRange from './observation-reference-range.ts'

const ResourceType = 'ObservationComponent' as const
type ResourceType = typeof ResourceType

const fields = {
  code: CodeableConcept.Schema,
  dataAbsentReason: Schema.optional(CodeableConcept.Schema),
  interpretation: Schema.Array(CodeableConcept.Schema).pipe(
    AnnotateArrayWithArbitrary({ maxLength: 2 }),
    Schema.optionalWith({ default: () => [] })
  ),
  referenceRange: Schema.Array(ObservationReferenceRange.Schema).pipe(
    AnnotateArrayWithArbitrary({ maxLength: 2 }),
    Schema.optionalWith({ default: () => [] })
  ),
  ...DatatypeChoice.DatatypeChoice('value', FhirR4ChoiceElements['Observation.component.value[x]'])
    .fields,
} as const satisfies FieldsNoContext

/**
 * A component result within an Observation, carrying its own code and
 * value[x] choice.
 */
const ObservationComponentSchema = StructNoContext({
  ...BackboneElementSchema.fields,
  ...fields,
})

export { ObservationComponentSchema as Schema, ResourceType }
