import { Schema } from 'effect'

import { Resource, BackboneElement, Identifier } from '../../data-types/index.ts'

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

// oxlint-disable @typescript-eslint/no-explicit-any
interface BundleEntry<BundleContentType> extends BackboneElement<'BundleEntry'> {
  fullUrl?: URL
  link?: any[]
  request?: any
  resource?: BundleContentType
  response?: any
  search?: any
}
// oxlint-enable @typescript-eslint/no-explicit-any

/**
 * Decoded shape of a FHIR R4 Bundle — a container for a collection of resources.
 *
 * @typeParam T - The resource type contained in the bundle entries
 */
export interface Bundle<T> extends Resource<'Bundle'> {
  entry?: BundleEntry<T>[]
  identifier?: Identifier
  link?: unknown[]
  signature?: unknown
  timestamp?: string
  total?: number
  type: Schema.Schema.Type<typeof BundleType>
}

/**
 * An entry in a bundle resource - will either contain a resource or information
 * about a resource (transactions and history only).
 */
const BundleEntrySchema = <BundleContentType, BundleContentEncoded>(
  contentTypeSchema: Schema.Schema<BundleContentType, BundleContentEncoded>
  // oxlint-disable-next-line typescript/explicit-function-return-type
) => {
  return Schema.Struct({
    ...BackboneElement('BundleEntry').fields,
    fullUrl: Schema.optional(Schema.URL),
    link: Schema.optional(Schema.mutable(Schema.Array(Schema.Any))),
    request: Schema.optional(Schema.Any),
    resource: Schema.optional(contentTypeSchema),
    response: Schema.optional(Schema.Any),
    search: Schema.optional(Schema.Any),
  })
}

/**
 * A container for a collection of resources. Call `Bundle.Schema(contentSchema)`
 * to produce a typed Effect Schema for a specific entry content type.
 *
 * @remarks
 * Unlike other resources, Bundle is not a Schema.Class — it exposes a
 * `Schema` factory method that parameterizes the entry content type.
 */
export const Bundle = {
  /**
   * Creates an Effect Schema for a Bundle whose entries contain `BundleContentType`.
   *
   * @typeParam BundleContentType - Decoded type of bundle entry resources
   * @typeParam BundleContentEncoded - Encoded type of bundle entry resources
   * @param contentTypeSchema - Schema for the entry resource type
   */
  // oxlint-disable-next-line typescript-eslint/explicit-function-return-type -- return type depends on generic schema parameter
  Schema: <BundleContentType, BundleContentEncoded>(
    contentTypeSchema: Schema.Schema<BundleContentType, BundleContentEncoded>
  ) =>
    Schema.Struct({
      ...Resource('Bundle').fields,
      entry: Schema.optional(Schema.mutable(Schema.Array(BundleEntrySchema(contentTypeSchema)))),
      identifier: Schema.optional(Schema.suspend(() => Identifier)),
      link: Schema.optional(Schema.mutable(Schema.Array(Schema.Any))),
      signature: Schema.optional(Schema.Any),
      timestamp: Schema.optional(Schema.String),
      total: Schema.optional(Schema.Int),
      type: BundleType,
    }),
}
