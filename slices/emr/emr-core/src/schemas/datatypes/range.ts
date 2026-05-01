import { Schema } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { registerDatatypeSchema } from '../datatype-registry.ts'
import { Schema as ElementSchema } from './element.ts'
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

registerDatatypeSchema(ResourceType, RangeSchema)

export { ResourceType, RangeSchema as Schema }
