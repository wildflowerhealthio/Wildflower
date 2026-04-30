import { Schema as ES } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as ElementSchema } from '../base/element.ts'
import { Datatype as makeDatatype } from '../datatype.ts'
import { Code } from './code.ts'

const ResourceType = 'Attachment' as const
type ResourceType = typeof ResourceType

const fields = {
  contentType: ES.NullOr(Code),
  language: ES.NullOr(Code),
  data: ES.NullOr(ES.String),
  url: ES.NullOr(ES.String),
  size: ES.NullOr(ES.Int),
  hash: ES.NullOr(ES.String),
  title: ES.NullOr(ES.String),
  creation: ES.NullOr(ES.DateTimeUtc),
} as const satisfies FieldsNoContext

/**
 * For identifying specific representations or attachments.
 * This data type is used for all attachments including images, documents, etc.
 * Note: Per FHIR spec, if data is present, contentType SHALL be populated.
 */
const Schema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

const Datatype = makeDatatype(ResourceType, Schema)

export { Datatype, ResourceType, Schema }
