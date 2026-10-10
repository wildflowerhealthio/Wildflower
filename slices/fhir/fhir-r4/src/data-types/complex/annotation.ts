import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import { ReferenceSchema } from './identifier-and-reference.ts'

const AnnotationStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    authorReference: OrNullAsOptional(Schema.suspend(() => ReferenceSchema)),
    authorString: OrNullAsOptional(Schema.String),
    text: Schema.String,
    time: OrNullAsOptional(Schema.DateTimeUtc),
  })
)

const AnnotationSchema: Schema.Schema<typeof AnnotationStruct.Type, FhirR4.Annotation, never> =
  AnnotationStruct

registerDatatypeSchema('Annotation', AnnotationSchema)

export { AnnotationSchema as Schema }
