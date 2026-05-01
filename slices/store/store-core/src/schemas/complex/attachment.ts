import { Schema } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as ElementSchema } from '../base/element.ts'
import { Datatype as makeDatatype } from '../datatype.ts'
import { Code } from './code.ts'

const ResourceType = 'Attachment' as const
type ResourceType = typeof ResourceType

const fields = {
  contentType: Schema.NullOr(Code),
  language: Schema.NullOr(Code),
  data: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  size: Schema.NullOr(Schema.Int),
  hash: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  creation: Schema.NullOr(Schema.DateTimeUtc),
} as const satisfies FieldsNoContext

/**
 * For identifying specific representations or attachments.
 * This data type is used for all attachments including images, documents, etc.
 * Note: Per FHIR spec, if data is present, contentType SHALL be populated.
 */
const AttachmentSchema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

const Datatype = makeDatatype(ResourceType, AttachmentSchema)

export { Datatype, ResourceType, AttachmentSchema as Schema }
