import { Schema } from 'effect'

import type { Observation as StoreObservation } from 'emr-core/livestore'
import { StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as Quantity from '../../data-types/complex/quantity.ts'
import * as Range from '../../data-types/complex/range.ts'

const ObservationReferenceRangeSchema: Schema.Schema<
  typeof StoreObservation.ReferenceRange.Schema.Type,
  FhirR4.ObservationReferenceRange,
  never
> = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    age: Schema.optional(Schema.suspend(() => Range.Schema)),
    appliesTo: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
      { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
    ),
    high: Schema.optional(Schema.suspend(() => Quantity.Schema)),
    low: Schema.optional(Schema.suspend(() => Quantity.Schema)),
    text: Schema.optional(Schema.String),
    type: Schema.optional(Schema.suspend(() => CodeableConcept.Schema)),
  })
)

export { ObservationReferenceRangeSchema as Schema }
