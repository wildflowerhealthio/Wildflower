import { Schema } from 'effect'

import type { SimpleQuantity as StoreSimpleQuantity } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

// SimpleQuantity is a Quantity without `comparator`. FhirR4's TS types alias
// it to `Quantity`, so the wire shape is identical apart from the absent
// `comparator` field.
const SimpleQuantitySchema: Schema.Schema<
  typeof StoreSimpleQuantity.Schema.Type,
  FhirR4.Quantity,
  never
> = mutableEncoded(
  StructNoContext({
    code: OrNullAsOptional(Schema.String),
    system: OrNullAsOptional(Schema.String),
    unit: OrNullAsOptional(Schema.String),
    value: OrNullAsOptional(Schema.Finite),
  })
)

export { SimpleQuantitySchema as Schema }
