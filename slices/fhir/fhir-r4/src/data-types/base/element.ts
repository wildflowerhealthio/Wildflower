import { Schema } from 'effect'

import {
  mutableEncoded,
  OrNullAsOptional,
  type FieldsNoContext,
  AnnotateArrayWithArbitrary,
} from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as Extension from '../special-purpose/extension.ts'

const fields = {
  id: OrNullAsOptional(Schema.String),
  extension: Schema.Array(Schema.suspend(() => Extension.Schema)).pipe(
    AnnotateArrayWithArbitrary({ maxLength: 2 }),
    mutableEncoded,
    Schema.optionalWith({ default: (): Extension.Type[] => [] })
  ),
} as const satisfies FieldsNoContext

const ElementStruct = mutableEncoded(Schema.Struct(fields))

const ElementSchema: Schema.Schema<typeof ElementStruct.Type, FhirR4.Element, never> = ElementStruct

export { fields, ElementSchema as Schema }
