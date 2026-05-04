import { Schema } from 'effect'

import { type Bundle as StoreBundle } from 'emr-core/schemas'
import { mutableEncoded, OrNullAsOptional, StructNoContext } from 'kitchen-sink/schema'

import type FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../base/backbone-element.ts'
import * as Resource from '../base/resource.ts'
import { IdentifierSchema } from '../complex/identifier-and-reference.ts'

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

const EntrySchema = <ContentTypeSchema extends Schema.Schema.AnyNoContext>(
  contentTypeSchema: ContentTypeSchema
): Schema.Schema<
  Schema.Schema.Type<
    ReturnType<typeof StoreBundle.EntrySchema<Schema.Schema.Type<ContentTypeSchema>, unknown>>
  >,
  Omit<FhirR4.BundleEntry, 'resource'> & {
    resource?: Schema.Schema.Encoded<ContentTypeSchema> | undefined
  },
  never
> =>
  mutableEncoded(
    StructNoContext({
      ...BackboneElement.fields,
      fullUrl: OrNullAsOptional(Schema.URL),
      link: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.Any)), {
        default: (): [] => [],
      }),
      request: OrNullAsOptional(Schema.Any),
      resource: OrNullAsOptional(contentTypeSchema),
      response: OrNullAsOptional(Schema.Any),
      search: OrNullAsOptional(Schema.Any),
    })
  )

const bundleTypeEnum = [
  'document',
  'message',
  'transaction',
  'transaction-response',
  'batch',
  'batch-response',
  'history',
  'searchset',
  'collection',
] as const

const bundleJsonSchema = {
  type: 'object',
  title: 'Bundle',
  description: 'A container for a collection of resources.',
  required: ['resourceType', 'type'],
  properties: {
    resourceType: { type: 'string', enum: ['Bundle'] },
    id: { type: 'string', description: 'Logical id of this artifact.' },
    meta: { type: 'object', description: 'Metadata about the resource.' },
    implicitRules: { type: 'string', format: 'uri' },
    language: { type: 'string', description: 'Language of the resource content.' },
    identifier: {
      type: 'object',
      description:
        'A persistent identifier for the bundle that will not change as a bundle is copied from server to server.',
    },
    type: {
      type: 'string',
      enum: bundleTypeEnum,
      description: 'Indicates the purpose of this bundle - how it is intended to be used.',
    },
    timestamp: {
      type: 'string',
      format: 'date-time',
      description: 'The date/time that the bundle was assembled.',
    },
    total: {
      type: 'integer',
      description:
        'If a set of search matches, this is the (potentially estimated) total number of entries of type "match" across all pages in the search.',
    },
    link: {
      type: 'array',
      items: { type: 'object' },
      description: 'A series of links that provide context to this bundle.',
    },
    entry: {
      type: 'array',
      items: {
        type: 'object',
        description:
          'An entry in a bundle resource - will either contain a resource or information about a resource (transactions and history only).',
        properties: {
          fullUrl: { type: 'string' },
          link: { type: 'array', items: { type: 'object' } },
          request: { type: 'object' },
          resource: { type: 'object' },
          response: { type: 'object' },
          search: { type: 'object' },
        },
      },
      description: 'An entry in a bundle resource.',
    },
    signature: {
      type: 'object',
      description: 'Digital Signature - base64 encoded. XML-DSig or a JWT.',
    },
  },
} as const

const BundleSchema = <FhirResourceSchema extends Schema.Schema.AnyNoContext>(
  resourceSchema: FhirResourceSchema
): Schema.Schema<
  Schema.Schema.Type<
    ReturnType<typeof StoreBundle.Schema<Schema.Schema.Type<FhirResourceSchema>, unknown>>
  >,
  FhirR4.Bundle<Schema.Schema.Encoded<FhirResourceSchema>>,
  never
> =>
  Schema.extend(
    StructNoContext({ resourceType: Schema.Literal('Bundle') }),
    mutableEncoded(
      StructNoContext({
        ...Resource.fields,
        entry: Schema.optionalWith(mutableEncoded(Schema.Array(EntrySchema(resourceSchema))), {
          default: (): [] => [],
        }),
        identifier: OrNullAsOptional(Schema.suspend(() => IdentifierSchema)),
        link: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.Any)), {
          default: (): [] => [],
        }),
        signature: OrNullAsOptional(Schema.Any),
        timestamp: OrNullAsOptional(Schema.String),
        total: OrNullAsOptional(Schema.Int),
        type: BundleType,
      })
    )
  ).annotations({ jsonSchema: bundleJsonSchema })

export { BundleType, EntrySchema, BundleSchema as Schema }
