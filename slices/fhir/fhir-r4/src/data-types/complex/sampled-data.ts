import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import * as SimpleQuantity from './simple-quantity.ts'

const SampledDataStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    origin: SimpleQuantity.Schema,
    period: Schema.Finite,
    factor: OrNullAsOptional(Schema.Finite),
    lowerLimit: OrNullAsOptional(Schema.Finite),
    upperLimit: OrNullAsOptional(Schema.Finite),
    dimensions: Schema.Int.pipe(Schema.positive()),
    data: OrNullAsOptional(Schema.String),
  })
)

const SampledDataSchema: Schema.Schema<typeof SampledDataStruct.Type, FhirR4.SampledData, never> =
  SampledDataStruct

registerDatatypeSchema('SampledData', SampledDataSchema)

export { SampledDataSchema as Schema }
