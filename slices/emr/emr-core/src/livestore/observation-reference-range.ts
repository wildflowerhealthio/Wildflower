import { Schema } from 'effect'

import {
  AnnotateArrayWithArbitrary,
  StructNoContext,
  type FieldsNoContext,
} from 'kitchen-sink/schema'

import { Schema as BackboneElementSchema } from '../schemas/base/backbone-element.ts'
import * as CodeableConcept from '../schemas/datatypes/codeable-concept.ts'
import * as Quantity from '../schemas/datatypes/quantity.ts'
import * as Range from '../schemas/datatypes/range.ts'

const ResourceType = 'ObservationReferenceRange' as const
type ResourceType = typeof ResourceType

const fields = {
  age: Schema.NullOr(Range.Schema),
  appliesTo: Schema.Array(CodeableConcept.Schema).pipe(
    AnnotateArrayWithArbitrary({ maxLength: 2 })
  ),
  high: Schema.NullOr(Quantity.Schema),
  low: Schema.NullOr(Quantity.Schema),
  text: Schema.NullOr(Schema.String),
  type: Schema.NullOr(CodeableConcept.Schema),
} as const satisfies FieldsNoContext

/**
 * Guidance on how to interpret an Observation value relative to normal or
 * recommended ranges.
 */
const ObservationReferenceRangeSchema = StructNoContext({
  ...BackboneElementSchema.fields,
  ...fields,
})

export { ResourceType, ObservationReferenceRangeSchema as Schema }
