import { Schema } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as ElementSchema } from '../base/element.ts'
import { Datatype as makeDatatype } from '../datatype.ts'
import { Schema as QuantitySchema } from './quantity.ts'

const ResourceType = 'Range' as const
type ResourceType = typeof ResourceType

const fields = {
  low: Schema.NullOr(QuantitySchema),
  high: Schema.NullOr(QuantitySchema),
} as const satisfies FieldsNoContext

/**
 * A set of ordered Quantities defined by a low and high limit.
 *
 * A Range specifies a set of possible values; usually, one value from the range applies
 * (e.g. "give the patient between 2 and 4 tablets"). Ranges are typically used in instructions.
 */
const RangeSchema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

const Datatype = makeDatatype(ResourceType, RangeSchema)

export { Datatype, ResourceType, RangeSchema as Schema }
