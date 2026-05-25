import { Schema } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { registerDatatypeSchema } from '../datatype-registry.ts'
import { Schema as ElementSchema } from './element.ts'
import { Schema as QuantitySchema } from './quantity.ts'

const ResourceType = 'Ratio' as const
type ResourceType = typeof ResourceType

const fields = {
  numerator: Schema.NullOr(QuantitySchema),
  denominator: Schema.NullOr(QuantitySchema),
} as const satisfies FieldsNoContext

/**
 * A relationship between two `Quantity` values, expressed as a numerator and
 * a denominator. Common use: medication strength (`250 mg / 5 mL`).
 */
const RatioSchema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

registerDatatypeSchema(ResourceType, RatioSchema)

export { ResourceType, RatioSchema as Schema }
