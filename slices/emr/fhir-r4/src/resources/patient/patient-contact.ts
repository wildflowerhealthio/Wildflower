import { Schema } from 'effect'

import type { Patient as StorePatient } from 'emr-core/livestore'
import { AdministrativeGender } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as Address from '../../data-types/complex/address.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as ContactPoint from '../../data-types/complex/contact-point.ts'
import * as HumanName from '../../data-types/complex/human-name.ts'
import * as Reference from '../../data-types/complex/identifier-and-reference.ts'
import * as Period from '../../data-types/complex/period.ts'

const PatientContactSchema: Schema.Schema<
  typeof StorePatient.Contact.Schema.Type,
  FhirR4.PatientContact,
  never
> = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    address: OrNullAsOptional(Schema.suspend(() => Address.Schema)),
    gender: OrNullAsOptional(AdministrativeGender),
    name: OrNullAsOptional(Schema.suspend(() => HumanName.Schema)),
    organization: OrNullAsOptional(Schema.suspend(() => Reference.ReferenceSchema)),
    period: OrNullAsOptional(Schema.suspend(() => Period.Schema)),
    relationship: OrNullAsOptional(
      mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema)))
    ),
    telecom: OrNullAsOptional(
      mutableEncoded(Schema.Array(Schema.suspend(() => ContactPoint.Schema)))
    ),
  })
)

export { PatientContactSchema as Schema }
