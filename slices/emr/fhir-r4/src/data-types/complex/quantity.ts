import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { Code } from '../base/code.ts'
import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
// Type-only: SimpleQuantity and Quantity don't import each other at runtime, so
// this keeps the widening helper here without introducing a module cycle.
import type * as SimpleQuantity from './simple-quantity.ts'

const QuantityStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    code: OrNullAsOptional(Code),
    comparator: OrNullAsOptional(
      Schema.Union(
        Schema.Literal('<'),
        Schema.Literal('<='),
        Schema.Literal('>='),
        Schema.Literal('>')
      )
    ),
    system: OrNullAsOptional(Schema.String),
    unit: OrNullAsOptional(Schema.String),
    value: OrNullAsOptional(Schema.Finite),
  })
)

const QuantitySchema: Schema.Schema<typeof QuantityStruct.Type, FhirR4.Quantity, never> =
  QuantityStruct

registerDatatypeSchema('Quantity', QuantitySchema)

/**
 * Widen a {@link SimpleQuantity} (no `comparator`, unbranded `code`) to a full
 * `Quantity`: brand `code` as a FHIR `code` primitive and add the absent
 * `comparator` slot. Every other field is shared and passes through unchanged.
 */
const fromSimpleQuantity = (
  simple: typeof SimpleQuantity.Schema.Type
): typeof QuantityStruct.Type => ({
  id: simple.id,
  extension: simple.extension,
  code: simple.code === null ? null : Code.make(simple.code),
  comparator: null,
  system: simple.system,
  unit: simple.unit,
  value: simple.value,
})

export { QuantitySchema as Schema, fromSimpleQuantity }
