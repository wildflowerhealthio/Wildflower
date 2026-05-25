import { Schema } from 'effect'

import type { SimpleQuantity as StoreSimpleQuantity } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'

// SimpleQuantity is a Quantity without `comparator`. FhirR4's TS types alias
// it to `Quantity`, so the wire shape is identical apart from the absent
// `comparator` field. Spread `Element.fields` so wire `id` / `extension`
// survive a round-trip (matches every other complex fhir-r4 schema).
const SimpleQuantitySchema: Schema.Schema<
  typeof StoreSimpleQuantity.Schema.Type,
  FhirR4.Quantity,
  never
> = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    code: OrNullAsOptional(Schema.String),
    system: OrNullAsOptional(Schema.String),
    unit: OrNullAsOptional(Schema.String),
    value: OrNullAsOptional(Schema.Finite),
  })
)

registerDatatypeSchema('SimpleQuantity', SimpleQuantitySchema)

export { SimpleQuantitySchema as Schema }
