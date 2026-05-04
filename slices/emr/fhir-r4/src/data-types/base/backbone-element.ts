import { Schema } from 'effect'

import type {
  BackboneElement as StoreBackboneElement,
  Extension as StoreExtension,
} from 'emr-core/schemas'
import { mutableEncoded, type FieldsNoContext } from 'kitchen-sink/schema'

import type FhirR4 from 'fhir/r4.d.ts'

import * as Extension from '../special-purpose/extension.ts'
import * as Element from './element.ts'

const fields = {
  ...Element.fields,
  modifierExtension: Schema.optionalWith(
    mutableEncoded(Schema.Array(Schema.suspend(() => Extension.Schema))),
    { default: (): readonly StoreExtension.Type[] => [] }
  ),
} as const satisfies FieldsNoContext

const BackboneElementSchema: Schema.Schema<
  typeof StoreBackboneElement.Schema.Type,
  FhirR4.BackboneElement,
  never
> = mutableEncoded(Schema.Struct(fields))

export { fields, BackboneElementSchema as Schema }
