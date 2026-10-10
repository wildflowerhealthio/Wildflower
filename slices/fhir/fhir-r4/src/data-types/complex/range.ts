import { type Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import * as Quantity from './quantity.ts'

const RangeStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    high: OrNullAsOptional(Quantity.Schema),
    low: OrNullAsOptional(Quantity.Schema),
  })
)

const RangeSchema: Schema.Schema<typeof RangeStruct.Type, FhirR4.Range, never> = RangeStruct

registerDatatypeSchema('Range', RangeSchema)

export { RangeSchema as Schema }
