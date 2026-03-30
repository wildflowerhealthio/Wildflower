import { Schema } from 'effect'

import { Coding } from '../complex/coding.ts'
import type { CodingEncoded } from '../complex/coding.ts'

const ResourceType = 'Meta' as const
type ResourceType = typeof ResourceType

const fields = {
  versionId: Schema.optional(Schema.String),
  lastUpdated: Schema.optional(Schema.DateTimeUtc),
  source: Schema.optional(Schema.String),
  // oxfmt-ignore
  // profile: canonical(StructureDefinition),
  security: Schema.optional(
    Schema.Array(Schema.suspend((): Schema.Schema<Coding, CodingEncoded> => Coding))
  ),
  tag: Schema.optional(
    Schema.Array(Schema.suspend((): Schema.Schema<Coding, CodingEncoded> => Coding))
  ),
} as const satisfies Schema.Struct.Fields

/** Encoded (wire-format) shape of a {@link Meta}. */
export interface MetaEncoded extends Schema.Struct.Encoded<typeof fields> {}

/**
 * FHIR R4 Meta data type — resource-level metadata including version, last
 * updated timestamp, source, security labels, and tags.
 */
export class Meta extends Schema.Class<Meta>(ResourceType)(fields) {
  static readonly ResourceType = ResourceType
}
