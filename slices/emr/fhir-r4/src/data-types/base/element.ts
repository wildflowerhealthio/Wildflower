import { Schema } from 'effect'

import type { Element, Extension as StoreExtension } from 'emr-core/schemas'
import { mutableEncoded, OrNullAsOptional, type FieldsNoContext } from 'kitchen-sink/schema'

import type FhirR4 from 'fhir/r4.d.ts'

import * as Extension from '../special-purpose/extension.ts'

const fields = {
  id: OrNullAsOptional(Schema.String),
  extension: Schema.optionalWith(
    mutableEncoded(Schema.Array(Schema.suspend(() => Extension.Schema))),
    { default: (): StoreExtension.Type[] => [] }
  ),
} as const satisfies FieldsNoContext

const ElementSchema: Schema.Schema<typeof Element.Schema.Type, FhirR4.Element, never> =
  mutableEncoded(Schema.Struct(fields))

export { fields, ElementSchema as Schema }
