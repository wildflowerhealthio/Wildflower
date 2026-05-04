import { Schema } from 'effect'

import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { registerDatatypeSchema } from '../datatype-registry.ts'
import { Schema as CodingSchema } from './coding.ts'

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const ResourceType = 'Meta' as const
type ResourceType = typeof ResourceType

// `Arbitrary.make(...)` caps `security` and `tag` arrays to length ≤ 2;
// FHIR allows any number of codings, so production decode/encode behavior
// is unchanged. The cap exists to keep property-test fan-out tractable —
// every Resource-shell test (Patient/Observation/Bundle/...) generates a
// Meta as part of its arbitrary, and unbounded Coding[] arrays here drove
// shell-level property tests past their timeouts.
const fields = {
  versionId: Schema.NullOr(Schema.String),
  lastUpdated: Schema.NullOr(Schema.DateTimeUtc),
  source: Schema.NullOr(Schema.String),
  security: Schema.Array(CodingSchema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  tag: Schema.Array(CodingSchema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
} as const satisfies Schema.Struct.Fields

/**
 * FHIR R4 Meta data type — resource-level metadata including version, last
 * updated timestamp, source, security labels, and tags.
 */
const MetaSchema = Schema.Struct(fields)

registerDatatypeSchema(ResourceType, MetaSchema)

export { ResourceType, MetaSchema as Schema }
