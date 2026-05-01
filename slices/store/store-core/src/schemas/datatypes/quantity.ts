import { Schema } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { registerDatatypeSchema } from '../datatype-registry.ts'
import { Code } from './code.ts'
import { Schema as ElementSchema } from './element.ts'

const ResourceType = 'Quantity' as const
type ResourceType = typeof ResourceType

/** How the value should be understood and represented - whether the actual value is greater or less than the stated value due to measurement issues. */
const ComparatorSchema = Schema.Union(
  Schema.Literal('<'),
  Schema.Literal('<='),
  Schema.Literal('>='),
  Schema.Literal('>')
)
type Comparator = typeof ComparatorSchema.Type

const fields = {
  value: Schema.NullOr(Schema.Finite),
  unit: Schema.NullOr(Schema.String),
  system: Schema.NullOr(Schema.String),
  code: Schema.NullOr(Code),
  comparator: Schema.NullOr(ComparatorSchema),
} as const satisfies FieldsNoContext

/**
 * A measured amount (or an amount that can potentially be measured).
 *
 * Note that measured amounts include amounts that are not precisely quantified, including amounts
 * involving arbitrary units and floating currencies.
 *
 * The context of use may frequently define what kind of quantity this is and therefore what kind
 * of units can be used. The context of use may also restrict the values for the comparator.
 */
const QuantitySchema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

registerDatatypeSchema(ResourceType, QuantitySchema)

export { ResourceType, ComparatorSchema, QuantitySchema as Schema }
export type { Comparator }
