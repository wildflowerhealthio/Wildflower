import { Schema } from 'effect'

import { type Meta as StoreMeta } from 'emr-core/schemas'
import { mutableEncoded, OrNullAsOptional } from 'kitchen-sink/schema'

import type FhirR4 from 'fhir/r4.d.ts'

import * as Coding from '../complex/coding.ts'

const MetaSchema: Schema.Schema<typeof StoreMeta.Schema.Type, FhirR4.Meta, never> = mutableEncoded(
  Schema.Struct({
    lastUpdated: OrNullAsOptional(Schema.DateTimeUtc),
    security: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => Coding.Schema))),
      { default: (): readonly (typeof Coding.Schema.Type)[] => [] }
    ),
    source: OrNullAsOptional(Schema.String),
    tag: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.suspend(() => Coding.Schema))), {
      default: (): readonly (typeof Coding.Schema.Type)[] => [],
    }),
    versionId: OrNullAsOptional(Schema.String),
  })
)

export { MetaSchema as Schema }
