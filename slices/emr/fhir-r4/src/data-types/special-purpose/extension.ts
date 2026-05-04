import { Schema } from 'effect'

import { Datatype } from 'emr-core/schemas'
import type { Extension as StoreExtension } from 'emr-core/schemas'
import { mutableEncoded, OrNullAsOptional, StructNoContext } from 'kitchen-sink/schema'

import type FhirR4 from 'fhir/r4.d.ts'

import { choiceElementSetPassthroughFields } from '../base/choice-element-passthrough-fields.ts'

const ExtensionSchema: Schema.Schema<StoreExtension.Type, FhirR4.Extension, never> = mutableEncoded(
  StructNoContext({
    id: OrNullAsOptional(Schema.String),
    extension: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => ExtensionSchema))),
      { default: (): readonly StoreExtension.Type[] => [] }
    ),
    url: Schema.String,
    ...choiceElementSetPassthroughFields('value', Datatype.names),
  })
)

export { ExtensionSchema as Schema }
