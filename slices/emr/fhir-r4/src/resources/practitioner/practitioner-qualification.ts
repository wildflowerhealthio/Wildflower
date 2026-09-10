import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'
import * as Period from '../../data-types/complex/period.ts'

// FHIR R4 `Practitioner.qualification` — a certification, license or training
// the practitioner holds. `code` is required (1..1); `identifier`, `period`
// and `issuer` (a `Reference(Organization)`) are optional.
const PractitionerQualificationStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    identifier: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.IdentifierSchema))),
      { default: (): readonly (typeof IdentifierAndReference.IdentifierSchema.Type)[] => [] }
    ),
    code: Schema.suspend(() => CodeableConcept.Schema),
    period: OrNullAsOptional(Schema.suspend(() => Period.Schema)),
    issuer: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
  })
)

const PractitionerQualificationSchema: Schema.Schema<
  typeof PractitionerQualificationStruct.Type,
  FhirR4.PractitionerQualification,
  never
> = PractitionerQualificationStruct

export { PractitionerQualificationSchema as Schema }
