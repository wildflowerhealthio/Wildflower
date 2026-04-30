import { Schema as ES } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as ElementSchema } from '../base/element.ts'
import { Datatype as makeDatatype } from '../datatype.ts'
import { Code } from './code.ts'

const ResourceType = 'Quantity' as const
type ResourceType = typeof ResourceType

const fields = {
  value: ES.NullOr(ES.Finite),
  unit: ES.NullOr(ES.String),
  system: ES.NullOr(ES.String),
  code: ES.NullOr(Code),
  comparator: ES.NullOr(
    ES.Union(ES.Literal('<'), ES.Literal('<='), ES.Literal('>='), ES.Literal('>'))
  ),
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
const Schema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

const Datatype = makeDatatype(ResourceType, Schema)

export { Datatype, ResourceType, Schema }
