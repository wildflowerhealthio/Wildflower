import { Schema as ES } from 'effect'

import { Schema as CodingSchema } from '../complex/coding.ts'

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const ResourceType = 'Meta' as const
type ResourceType = typeof ResourceType

const fields = {
  versionId: ES.NullOr(ES.String),
  lastUpdated: ES.NullOr(ES.DateTimeUtc),
  source: ES.NullOr(ES.String),
  security: ES.Array(CodingSchema),
  tag: ES.Array(CodingSchema),
} as const satisfies ES.Struct.Fields

/**
 * FHIR R4 Meta data type — resource-level metadata including version, last
 * updated timestamp, source, security labels, and tags.
 */
const Schema = ES.Struct(fields)

export { ResourceType, Schema }
