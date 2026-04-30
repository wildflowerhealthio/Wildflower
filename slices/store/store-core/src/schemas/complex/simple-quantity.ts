import { Schema as ES } from 'effect'

const ResourceType = 'SimpleQuantity' as const
type ResourceType = typeof ResourceType

const fields = {
  /**
   * The value of the measured amount. The value includes an implicit precision in the presentation of the value.
   */
  value: ES.NullOr(ES.Finite),
  /**
   * A human-readable form of the unit.
   */
  unit: ES.NullOr(ES.String),
  /**
   * The identification of the system that provides the coded form of the unit.
   */
  system: ES.NullOr(ES.String),
  /**
   * A computer processable form of the unit in some unit representation system.
   */
  code: ES.NullOr(ES.String),
} as const satisfies ES.Struct.Fields

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
const Schema = ES.Struct(fields)

/** Encoded (wire-format) shape of a SimpleQuantity. */
interface SimpleQuantityEncoded extends ES.Struct.Encoded<typeof fields> {}

export { ResourceType, Schema }
export type { SimpleQuantityEncoded }
