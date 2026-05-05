import { Schema } from 'effect'

import type { Observation as StoreObservation } from 'emr-core/livestore'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

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
    age: OrNullAsOptional(Schema.suspend(() => Range.Schema)),
    appliesTo: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
      { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
    ),
    high: OrNullAsOptional(Schema.suspend(() => Quantity.Schema)),
    low: OrNullAsOptional(Schema.suspend(() => Quantity.Schema)),
    text: OrNullAsOptional(Schema.String),
    type: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
  })
)

export { ObservationReferenceRangeSchema as Schema }
