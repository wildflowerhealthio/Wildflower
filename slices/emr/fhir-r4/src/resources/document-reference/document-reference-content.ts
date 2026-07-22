import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as Attachment from '../../data-types/complex/attachment.ts'
import * as Coding from '../../data-types/complex/coding.ts'

// FHIR R4 `DocumentReference.content` — the document and format referenced.
// `attachment` is required (1..1); `format` is an optional `Coding`. The parent
// resource carries `content` as a required 1..* array.
const DocumentReferenceContentStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    attachment: Schema.suspend(() => Attachment.Schema),
    format: OrNullAsOptional(Schema.suspend(() => Coding.Schema)),
  })
)

const DocumentReferenceContentSchema: Schema.Schema<
  typeof DocumentReferenceContentStruct.Type,
  FhirR4.DocumentReferenceContent,
  never
> = DocumentReferenceContentStruct

export { DocumentReferenceContentSchema as Schema }
