import { Schema } from 'effect'

import { Code } from 'emr-core/schemas'
import type { Quantity as StoreQuantity } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type FhirR4 from 'fhir/r4.d.ts'

import * as Element from '../base/element.ts'

const QuantitySchema: Schema.Schema<typeof StoreQuantity.Schema.Type, FhirR4.Quantity, never> =
  mutableEncoded(
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

export { QuantitySchema as Schema }
