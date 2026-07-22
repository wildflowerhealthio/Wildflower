import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'
import * as Period from '../../data-types/complex/period.ts'

// FHIR R4 `DocumentReference.context` — the clinical context in which the
// document was prepared. All fields are optional (0..1 / 0..*).
const DocumentReferenceContextStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    encounter: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
      { default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [] }
    ),
    event: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
      { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
    ),
    period: OrNullAsOptional(Schema.suspend(() => Period.Schema)),
    facilityType: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    practiceSetting: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    sourcePatientInfo: OrNullAsOptional(
      Schema.suspend(() => IdentifierAndReference.ReferenceSchema)
    ),
    related: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
      { default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [] }
    ),
  })
)

const DocumentReferenceContextSchema: Schema.Schema<
  typeof DocumentReferenceContextStruct.Type,
  FhirR4.DocumentReferenceContext,
  never
> = DocumentReferenceContextStruct

export { DocumentReferenceContextSchema as Schema }
