import { Schema } from 'effect'

import { Element } from '../base/element.ts'
import type { ElementEncoded } from '../base/element.ts'
import { Quantity } from './quantity.ts'

const ResourceType = 'Range'

const fields = {
  /**
   * The low limit. The boundary is inclusive.
   */
  low: Schema.optional(Quantity),
  /**
   * The high limit. The boundary is inclusive.
   */
  high: Schema.optional(Quantity),
} as const satisfies Schema.Struct.Fields

const RangeElement = Element(ResourceType)

/** Encoded (wire-format) shape of a {@link Range}. */
export interface RangeEncoded
  extends Schema.Struct.Encoded<typeof fields>, ElementEncoded<typeof ResourceType> {}

/**
 * A set of ordered Quantities defined by a low and high limit.
 *
 * A Range specifies a set of possible values; usually, one value from the range applies
 * (e.g. "give the patient between 2 and 4 tablets"). Ranges are typically used in instructions.
 */
export class Range extends RangeElement.extend<Range>(ResourceType)(fields) {
  static readonly ResourceType = RangeElement.ResourceType
  static readonly IdSchema = RangeElement.IdSchema
}
