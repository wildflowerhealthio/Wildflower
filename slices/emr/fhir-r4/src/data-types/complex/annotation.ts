import { Schema } from 'effect'

import type { Annotation as StoreAnnotation } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as Element from '../base/element.ts'
import { ReferenceSchema } from './identifier-and-reference.ts'

const AnnotationSchema: Schema.Schema<
  typeof StoreAnnotation.Schema.Type,
  FhirR4.Annotation,
  never
> = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    authorReference: OrNullAsOptional(Schema.suspend(() => ReferenceSchema)),
    authorString: OrNullAsOptional(Schema.String),
    text: Schema.String,
    time: OrNullAsOptional(Schema.DateTimeUtc),
  })
)

export { AnnotationSchema as Schema }
