import { Schema } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { registerDatatypeSchema } from '../datatype-registry.ts'
import { Schema as ElementSchema } from './element.ts'

const ResourceType = 'SimpleQuantity' as const
type ResourceType = typeof ResourceType

const fields = {
  /**
   * The value of the measured amount. The value includes an implicit precision in the presentation of the value.
   */
  value: Schema.NullOr(Schema.Finite),
  /**
   * A human-readable form of the unit.
   */
  unit: Schema.NullOr(Schema.String),
  /**
   * The identification of the system that provides the coded form of the unit.
   */
  system: Schema.NullOr(Schema.String),
  /**
   * A computer processable form of the unit in some unit representation system.
   */
  code: Schema.NullOr(Schema.String),
} as const satisfies FieldsNoContext

/**
 * A fixed quantity (no comparator).
 *
 * A measured amount (or an amount that can potentially be measured). Note that measured amounts
 * include amounts that are not precisely quantified, including amounts involving arbitrary units
 * and floating currencies.
 *
 * The context of use may frequently define what kind of quantity this is and therefore what kind
 * of units can be used. The context of use may also restrict the values for the comparator.
 *
 * `SimpleQuantity` extends `Element` like every other FHIR datatype, so the
 * struct spreads `Element.fields` (`id`, `extension`) so wire payloads
 * carrying those slots round-trip without silent drops.
 */
const SimpleQuantitySchema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

registerDatatypeSchema(ResourceType, SimpleQuantitySchema)

export { ResourceType, SimpleQuantitySchema as Schema }
