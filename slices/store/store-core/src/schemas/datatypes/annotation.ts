import { Schema } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { registerDatatypeSchema } from '../datatype-registry.ts'
import { Schema as ElementSchema } from './element.ts'
import { Schema as ReferenceSchema } from './reference.ts'

const ResourceType = 'Annotation' as const
type ResourceType = typeof ResourceType

const fields = {
  authorString: Schema.NullOr(Schema.String),
  authorReference: Schema.NullOr(ReferenceSchema),
  time: Schema.NullOr(Schema.DateTimeUtc),
  text: Schema.String,
} as const satisfies FieldsNoContext

/**
 * A text note which also contains information about who made the statement and when.
 */
const AnnotationSchema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

registerDatatypeSchema(ResourceType, AnnotationSchema)

export { ResourceType, AnnotationSchema as Schema }
