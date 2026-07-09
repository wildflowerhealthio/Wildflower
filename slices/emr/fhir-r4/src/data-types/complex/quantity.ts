import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { Code } from '../base/code.ts'
import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'

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

export { QuantitySchema as Schema }
