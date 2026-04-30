import { Schema } from 'effect'

import { StructNoContext } from 'kitchen-sink/schema'
import { Schema as BackboneElementSchema } from './base/backbone-element.ts'
import * as Resource from './base/resource.ts'
import * as Identifier from './complex/identifier.ts'

const BundleType = Schema.Enums({
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
 * An entry in a bundle resource - will either contain a resource or information
 * about a resource (transactions and history only).
 */
const EntrySchema = <BundleContentType, BundleContentEncoded>(
  contentTypeSchema: Schema.Schema<BundleContentType, BundleContentEncoded, never>
  // oxlint-disable-next-line typescript/explicit-function-return-type
) => {
  return StructNoContext({
    ...BackboneElementSchema.fields,
    fullUrl: Schema.NullOr(Schema.URL),
    link: Schema.Array(Schema.Any),
    request: Schema.NullOr(Schema.Any),
    resource: Schema.NullOr(contentTypeSchema),
    response: Schema.NullOr(Schema.Any),
    search: Schema.NullOr(Schema.Any),
  })
}

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
      link: Schema.Array(Schema.Any),
      signature: Schema.NullOr(Schema.Any),
      timestamp: Schema.NullOr(Schema.String),
      total: Schema.NullOr(Schema.Int),
      type: BundleType,
    }),
  EntrySchema,
}
