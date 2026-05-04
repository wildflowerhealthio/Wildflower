import { Schema } from 'effect'

import { StructNoContext } from 'kitchen-sink/schema'
import { Schema as BackboneElementSchema } from './base/backbone-element.ts'
import * as Resource from './base/resource.ts'
import * as Identifier from './datatypes/identifier.ts'

/**
 * FHIR R4 value set for `Bundle.type`: document | message | transaction |
 * transaction-response | batch | batch-response | history | searchset |
 * collection.
 */
const TypeSchema = Schema.Enums({
  batch: 'batch',
  'batch-response': 'batch-response',
  collection: 'collection',
  document: 'document',
  history: 'history',
  message: 'message',
  searchset: 'searchset',
  transaction: 'transaction',
  'transaction-response': 'transaction-response',
} as const)

/**
 * Per FHIR R4 § Bundle, both `Bundle.link` and `Bundle.entry.link` carry the
 * same shape: a `relation` string plus a `url`.
 */
const LinkSchema = StructNoContext({
  ...BackboneElementSchema.fields,
  relation: Schema.String,
  url: Schema.String,
})

/**
 * FHIR R4 value set for `Bundle.entry.request.method`: HTTP verbs used in
 * transaction/batch bundles.
 */
const EntryRequestMethod = Schema.Enums({
  DELETE: 'DELETE',
  GET: 'GET',
  HEAD: 'HEAD',
  PATCH: 'PATCH',
  POST: 'POST',
  PUT: 'PUT',
} as const)

/**
 * Additional information about how this entry should be processed as part of
 * a transaction or batch. Required when the bundle type is transaction or
 * batch.
 */
const EntryRequestSchema = StructNoContext({
  ...BackboneElementSchema.fields,
  method: EntryRequestMethod,
  url: Schema.String,
  ifNoneMatch: Schema.NullOr(Schema.String),
  ifModifiedSince: Schema.NullOr(Schema.String),
  ifMatch: Schema.NullOr(Schema.String),
  ifNoneExist: Schema.NullOr(Schema.String),
})

/**
 * Indicates the results of processing the corresponding `request` (in a
 * transaction-response or batch-response bundle).
 */
const EntryResponseSchema = StructNoContext({
  ...BackboneElementSchema.fields,
  status: Schema.String,
  location: Schema.NullOr(Schema.String),
  etag: Schema.NullOr(Schema.String),
  lastModified: Schema.NullOr(Schema.DateTimeUtc),
})

/**
 * FHIR R4 value set for `Bundle.entry.search.mode`: match | include | outcome.
 */
const EntrySearchMode = Schema.Enums({
  include: 'include',
  match: 'match',
  outcome: 'outcome',
} as const)

/**
 * Information about the search process that lead to the creation of this
 * entry — `mode` (match/include/outcome) and an optional `score` (0–1).
 *
 * `score` is constrained to finite numbers because NaN/Infinity don't
 * round-trip through JSON (`JSON.stringify(NaN) === 'null'`).
 */
const EntrySearchSchema = StructNoContext({
  ...BackboneElementSchema.fields,
  mode: Schema.NullOr(EntrySearchMode),
  score: Schema.NullOr(Schema.Number.pipe(Schema.finite())),
})

/**
 * An entry in a bundle resource - will either contain a resource or information
 * about a resource (transactions and history only).
 */
const EntrySchema = <BundleContentType, BundleContentEncoded>(
  contentTypeSchema: Schema.Schema<BundleContentType, BundleContentEncoded, never>
  // oxlint-disable-next-line typescript/explicit-function-return-type
) =>
  StructNoContext({
    ...BackboneElementSchema.fields,
    fullUrl: Schema.NullOr(Schema.URL),
    link: Schema.Array(LinkSchema),
    request: Schema.NullOr(EntryRequestSchema),
    resource: Schema.NullOr(contentTypeSchema),
    response: Schema.NullOr(EntryResponseSchema),
    search: Schema.NullOr(EntrySearchSchema),
  })

/**
 * A container for a collection of resources. Call `Bundle.Schema(contentSchema)`
 * to produce a typed Effect Schema for a specific entry content type.
 *
 * @remarks
 * Unlike livestore-backed resources, Bundle is parameterised by the entry
 * content type, so it exposes a `Schema` factory method rather than a fixed
 * struct.
 */
export const Bundle = {
  /**
   * Creates an Effect Schema for a Bundle whose entries contain `BundleContentType`.
   *
   * @typeParam BundleContentType - Decoded type of bundle entry resources
   * @typeParam BundleContentEncoded - Encoded type of bundle entry resources
   * @param contentTypeSchema - Schema for the entry resource type
   */
  Schema: <BundleContentType, BundleContentEncoded>(
    contentTypeSchema: Schema.Schema<BundleContentType, BundleContentEncoded, never>
  ) =>
    StructNoContext({
      ...Resource.fields,
      resourceType: Schema.Literal('Bundle'),
      id: Schema.NullOr(Schema.String),
      entry: Schema.Array(EntrySchema(contentTypeSchema)),
      identifier: Schema.NullOr(Identifier.Schema),
      link: Schema.Array(LinkSchema),
      signature: Schema.NullOr(Schema.Any),
      timestamp: Schema.NullOr(Schema.String),
      total: Schema.NullOr(Schema.Int),
      type: TypeSchema,
    }),
  EntrySchema,
  EntryRequestSchema,
  EntryResponseSchema,
  EntrySearchSchema,
  LinkSchema,
}
