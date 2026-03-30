import { Schema } from 'effect'

/**
 * A fixed quantity (no comparator).
 *
 * A measured amount (or an amount that can potentially be measured). Note that measured amounts
 * include amounts that are not precisely quantified, including amounts involving arbitrary units
 * and floating currencies.
 *
 * The context of use may frequently define what kind of quantity this is and therefore what kind
 * of units can be used. The context of use may also restrict the values for the comparator.
 */
export const SimpleQuantity = Schema.Struct({
  /**
   * The value of the measured amount. The value includes an implicit precision in the presentation of the value.
   */
  value: Schema.optional(Schema.Finite),
  /**
   * A human-readable form of the unit.
   */
  unit: Schema.optional(Schema.String),
  /**
   * The identification of the system that provides the coded form of the unit.
   */
  system: Schema.optional(Schema.String),
  /**
   * A computer processable form of the unit in some unit representation system.
   */
  code: Schema.optional(Schema.String),
})

export type SimpleQuantity = typeof SimpleQuantity.Type
