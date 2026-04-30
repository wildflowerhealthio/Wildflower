import { Schema as ES } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as ElementSchema } from '../base/element.ts'
import { Datatype as makeDatatype } from '../datatype.ts'
import { Schema as ReferenceSchema } from './reference.ts'

const ResourceType = 'Annotation' as const
type ResourceType = typeof ResourceType

const fields = {
  authorString: ES.NullOr(ES.String),
  authorReference: ES.NullOr(ReferenceSchema),
  time: ES.NullOr(ES.DateTimeUtc),
  text: ES.String,
} as const satisfies FieldsNoContext

/**
 * A text note which also contains information about who made the statement and when.
 */
const Schema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

const Datatype = makeDatatype(ResourceType, Schema)

export { Datatype, ResourceType, Schema }
