import { Schema } from 'effect'

import { OrNullAsOptional, mutableEncoded, type FieldsNoContext } from 'kitchen-sink/schema'

import * as Extension from '../special-purpose/extension.ts'
import * as Narrative from '../special-purpose/narrative.ts'
import * as Resource from './resource.ts'

/**
 * Spreadable FHIR R4 DomainResource fields (everything except `resourceType`).
 * Adds `text`, `contained`, `extension`, `modifierExtension` on top of
 * {@link Resource.fields}. Spread into a `Schema.Struct` along with
 * `resourceType: Schema.Literal('X')` to build a full domain resource
 * wire-format schema.
 */
const fields = {
  ...Resource.fields,
  contained: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.Any)), {
    default: (): readonly unknown[] => [],
  }),
  extension: Schema.optionalWith(
    mutableEncoded(Schema.Array(Schema.suspend(() => Extension.Schema))),
    { default: (): readonly Extension.Type[] => [] }
  ),
  modifierExtension: Schema.optionalWith(
    mutableEncoded(Schema.Array(Schema.suspend(() => Extension.Schema))),
    { default: (): readonly Extension.Type[] => [] }
  ),
  text: OrNullAsOptional(Narrative.Schema),
} as const satisfies FieldsNoContext

export { fields }
