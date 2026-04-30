import { Schema as ES } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as ElementSchema } from '../base/element.ts'
import { Datatype as makeDatatype } from '../datatype.ts'
import { Schema as QuantitySchema } from './quantity.ts'

const ResourceType = 'Range' as const
type ResourceType = typeof ResourceType

const fields = {
  low: ES.NullOr(QuantitySchema),
  high: ES.NullOr(QuantitySchema),
} as const satisfies FieldsNoContext

/**
 * A set of ordered Quantities defined by a low and high limit.
 *
 * A Range specifies a set of possible values; usually, one value from the range applies
 * (e.g. "give the patient between 2 and 4 tablets"). Ranges are typically used in instructions.
 */
const Schema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

const Datatype = makeDatatype(ResourceType, Schema)

export { Datatype, ResourceType, Schema }
