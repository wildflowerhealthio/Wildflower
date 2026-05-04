import { Schema } from 'effect'

import { Code } from 'emr-core/schemas'
import type { Meta as StoreMeta } from 'emr-core/schemas'
import {
  mutableEncoded,
  OrNullAsOptional,
  StructNoContext,
  type FieldsNoContext,
} from 'kitchen-sink/schema'

import type FhirR4 from 'fhir/r4.d.ts'

import * as Meta from './meta.ts'

const metaField: Schema.optionalWith<
  Schema.Schema<typeof StoreMeta.Schema.Type | null, FhirR4.Meta | undefined>,
  { default: () => null }
> = OrNullAsOptional(Meta.Schema)

const fields = {
  id: OrNullAsOptional(Schema.String),
  implicitRules: OrNullAsOptional(Schema.URL),
  language: OrNullAsOptional(Code),
  meta: metaField,
} as const satisfies FieldsNoContext

/**
 * Spreadable FHIR R4 Resource fields (everything except `resourceType`).
 * Compose with `Schema.Struct({ resourceType: Schema.Literal('X') })` via
 * `Schema.extend` to build a full resource wire-format schema.
 */
const ResourceSchema: Schema.Schema<
  {
    readonly id: string | null
    readonly implicitRules: URL | null
    readonly language: typeof Code.Type | null
    readonly meta: typeof StoreMeta.Schema.Type | null
  },
  Omit<FhirR4.Resource, 'resourceType' | '_id' | '_implicitRules' | '_language' | '_meta'>,
  never
> = mutableEncoded(StructNoContext(fields))

export { fields, ResourceSchema as Schema }
