import { Schema } from 'effect'

import { Coding } from '../complex/coding.ts'
import type { CodingEncoded } from '../complex/coding.ts'

const ResourceType = 'Meta' as const
type ResourceType = typeof ResourceType

const fields = {
  versionId: Schema.UndefinedOr(Schema.String).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  lastUpdated: Schema.UndefinedOr(Schema.DateTimeUtc).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  source: Schema.UndefinedOr(Schema.String).pipe(Schema.optionalWith({ default: () => undefined })),
  // oxfmt-ignore
  // profile: canonical(StructureDefinition),
  security: Schema.UndefinedOr(
    Schema.Array(Schema.suspend((): Schema.Schema<Coding, CodingEncoded> => Coding))
  ).pipe(Schema.optionalWith({ default: () => undefined })),
  tag: Schema.UndefinedOr(
    Schema.Array(Schema.suspend((): Schema.Schema<Coding, CodingEncoded> => Coding))
  ).pipe(Schema.optionalWith({ default: () => undefined })),
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
