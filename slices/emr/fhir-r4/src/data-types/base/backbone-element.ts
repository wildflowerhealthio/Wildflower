import { Schema } from 'effect'

import { mutableEncoded, type FieldsNoContext } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as Extension from '../special-purpose/extension.ts'
import * as Element from './element.ts'

const fields = {
  ...Element.fields,
  modifierExtension: Schema.optionalWith(
    mutableEncoded(Schema.Array(Schema.suspend(() => Extension.Schema))),
    { default: (): readonly Extension.Type[] => [] }
  ),
} as const satisfies FieldsNoContext

const BackboneElementStruct = mutableEncoded(Schema.Struct(fields))

const BackboneElementSchema: Schema.Schema<
  typeof BackboneElementStruct.Type,
  FhirR4.BackboneElement,
  never
> = BackboneElementStruct

export { fields, BackboneElementSchema as Schema }
