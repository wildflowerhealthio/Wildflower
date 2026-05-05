import { Schema } from 'effect'

import type { Binary as StoreBinary } from 'emr-core/livestore'
import { Code } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as DomainResource from '../../data-types/base/domain-resource.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'

const binaryJsonSchema = {
  type: 'object',
  title: 'Binary',
  description:
    'A resource that represents the data of a single raw artifact as digital content accessible in its native format. A Binary resource can contain any content, whether text, image, pdf, zip archive, etc.',
  required: ['resourceType', 'contentType'],
  properties: {
    resourceType: { type: 'string', enum: ['Binary'] },
    id: { type: 'string', description: 'Logical id of this artifact.' },
    meta: { type: 'object', description: 'Metadata about the resource.' },
    implicitRules: {
      type: 'string',
      format: 'uri',
      description: 'A set of rules under which this content was created.',
    },
    language: { type: 'string', description: 'Language of the resource content.' },
    contentType: {
      type: 'string',
      description: 'MimeType of the binary content represented as a standard MimeType (BCP 13).',
    },
    data: {
      type: 'string',
      description:
        'The actual content, base64 encoded. If the content type is itself base64 encoding, then this will be base64 encoded twice.',
    },
    securityContext: {
      type: 'object',
      description:
        'A reference to a resource that provides guides, context or identifies the access rules that should be applied to the binary.',
    },
  },
} as const

const BinarySchema: Schema.Schema<
  Schema.Schema.Type<typeof StoreBinary.RowSchemaNullableId>,
  FhirR4.Binary,
  never
> = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('Binary') }),
  mutableEncoded(
    StructNoContext({
      ...DomainResource.fields,
      id: OrNullAsOptional(Schema.String),
      contentType: Code,
      data: OrNullAsOptional(Schema.String),
      securityContext: OrNullAsOptional(
        Schema.suspend(() => IdentifierAndReference.ReferenceSchema)
      ),
    })
  )
).annotations({ jsonSchema: binaryJsonSchema })

export { BinarySchema as Schema }
