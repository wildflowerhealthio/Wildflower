import { Schema } from 'effect'

import { Code } from 'emr-core/schemas'
import type { Attachment as StoreAttachment } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'

const AttachmentSchema: Schema.Schema<
  typeof StoreAttachment.Schema.Type,
  FhirR4.Attachment,
  never
> = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    contentType: OrNullAsOptional(Code),
    creation: OrNullAsOptional(Schema.DateTimeUtc),
    data: OrNullAsOptional(Schema.String),
    url: OrNullAsOptional(Schema.URL),
    hash: OrNullAsOptional(Schema.String),
    language: OrNullAsOptional(Code),
    size: OrNullAsOptional(Schema.Int),
    title: OrNullAsOptional(Schema.String),
  })
)

registerDatatypeSchema('Attachment', AttachmentSchema)

export { AttachmentSchema as Schema }
