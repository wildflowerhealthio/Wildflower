import type { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import * as Quantity from './quantity.ts'

const RatioStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    numerator: OrNullAsOptional(Quantity.Schema),
    denominator: OrNullAsOptional(Quantity.Schema),
  })
)

const RatioSchema: Schema.Schema<typeof RatioStruct.Type, FhirR4.Ratio, never> = RatioStruct

registerDatatypeSchema('Ratio', RatioSchema)

export { RatioSchema as Schema }
