import { Schema } from 'effect'

import { type Meta as StoreMeta } from 'emr-core/schemas'
import { mutableEncoded, OrNullAsOptional } from 'kitchen-sink/schema'

import type FhirR4 from 'fhir/r4.d.ts'

import * as Coding from '../complex/coding.ts'

const MetaSchema: Schema.Schema<typeof StoreMeta.Schema.Type, FhirR4.Meta, never> = Schema.Struct({
  lastUpdated: OrNullAsOptional(Schema.DateTimeUtc),
  // Canonical URLs identifying the StructureDefinition profiles this
  // resource conforms to. Required for US Core / SMART / USCDI profile
  // declarations (https://hl7.org/fhir/R4/resource.html#Meta).
  profile: Schema.Array(Schema.String).pipe(
    mutableEncoded,
    Schema.optionalWith({ default: (): readonly string[] => [] })
  ),
  security: Schema.Array(Schema.suspend(() => Coding.Schema)).pipe(
    mutableEncoded,
    Schema.optionalWith({ default: (): readonly (typeof Coding.Schema.Type)[] => [] })
  ),
  source: OrNullAsOptional(Schema.String),
  tag: Schema.Array(Schema.suspend(() => Coding.Schema)).pipe(
    mutableEncoded,
    Schema.optionalWith({ default: (): readonly (typeof Coding.Schema.Type)[] => [] })
  ),
  versionId: OrNullAsOptional(Schema.String),
}).pipe(mutableEncoded)

export { MetaSchema as Schema }
