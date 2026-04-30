import { Schema as ES } from 'effect'

import {
  AnnotateArrayWithArbitrary,
  StructNoContext,
  type FieldsNoContext,
} from 'kitchen-sink/schema'

import { Schema as BackboneElementSchema } from '../schemas/base/backbone-element.ts'
import * as CodeableConcept from '../schemas/complex/codeable-concept.ts'
import * as Quantity from '../schemas/complex/quantity.ts'
import * as Range from '../schemas/complex/range.ts'

const ResourceType = 'ObservationReferenceRange' as const
type ResourceType = typeof ResourceType

const fields = {
  age: ES.optional(Range.Schema),
  appliesTo: ES.Array(CodeableConcept.Schema).pipe(
    AnnotateArrayWithArbitrary({ maxLength: 2 }),
    ES.optionalWith({ default: () => [] })
  ),
  high: ES.optional(Quantity.Schema),
  low: ES.optional(Quantity.Schema),
  text: ES.optional(ES.String),
  type: ES.optional(CodeableConcept.Schema),
} as const satisfies FieldsNoContext

/**
 * Guidance on how to interpret an Observation value relative to normal or
 * recommended ranges.
 */
const Schema = StructNoContext({
  ...BackboneElementSchema.fields,
  ...fields,
})

export { ResourceType, Schema }
