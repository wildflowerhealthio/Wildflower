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
  value: Schema.UndefinedOr(Schema.Finite).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * A human-readable form of the unit.
   */
  unit: Schema.UndefinedOr(Schema.String).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * The identification of the system that provides the coded form of the unit.
   */
  system: Schema.UndefinedOr(Schema.String).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * A computer processable form of the unit in some unit representation system.
   */
  code: Schema.UndefinedOr(Schema.String).pipe(Schema.optionalWith({ default: () => undefined })),
})

export type SimpleQuantity = typeof SimpleQuantity.Type
