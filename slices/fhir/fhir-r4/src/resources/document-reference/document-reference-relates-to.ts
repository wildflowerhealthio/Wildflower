import { Schema } from 'effect'

import { StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'

/**
 * FHIR R4 value set for `DocumentReference.relatesTo.code`: replaces |
 * transforms | signs | appends.
 */
const RelationshipTypeSchema = Schema.Literal('replaces', 'transforms', 'signs', 'appends')

// FHIR R4 `DocumentReference.relatesTo` — a relationship this document has with
// another document reference that already exists. Both `code` and `target` are
// required (1..1) per spec, so neither is nullable here.
const DocumentReferenceRelatesToStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    code: RelationshipTypeSchema,
    target: Schema.suspend(() => IdentifierAndReference.ReferenceSchema),
  })
)

const DocumentReferenceRelatesToSchema: Schema.Schema<
  typeof DocumentReferenceRelatesToStruct.Type,
  FhirR4.DocumentReferenceRelatesTo,
  never
> = DocumentReferenceRelatesToStruct

export { DocumentReferenceRelatesToSchema as Schema, RelationshipTypeSchema }
