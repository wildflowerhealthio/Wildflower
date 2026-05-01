import { Schema } from 'effect'

import { Schema as CodingSchema } from '../complex/coding.ts'

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const ResourceType = 'Meta' as const
type ResourceType = typeof ResourceType

const fields = {
  versionId: Schema.NullOr(Schema.String),
  lastUpdated: Schema.NullOr(Schema.DateTimeUtc),
  source: Schema.NullOr(Schema.String),
  security: Schema.Array(CodingSchema),
  tag: Schema.Array(CodingSchema),
} as const satisfies Schema.Struct.Fields

/**
 * FHIR R4 Meta data type — resource-level metadata including version, last
 * updated timestamp, source, security labels, and tags.
 */
const MetaSchema = Schema.Struct(fields)

export { ResourceType, MetaSchema as Schema }
