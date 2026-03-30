import { Schema } from 'effect'

import {
  AnnotateArrayWithArbitrary,
  TimelessDateFromString,
  makeCloneWith,
} from 'kitchen-sink/schema'

import {
  AdministrativeGender,
  ContactPoint,
  CodeableConcept,
  Identifier,
  Reference,
  HumanName,
  Resource,
  Address,
  Attachment,
} from '../../data-types/index.ts'
import type { ResourceEncoded } from '../../data-types/index.ts'
import { PatientCommunication } from './patient-communication.ts'
import { PatientContact } from './patient-contact.ts'
import { PatientLink } from './patient-link.ts'

const DomainType = 'Patient' as const
type DomainType = typeof DomainType

// --- Patient ---

const fields = {
  active: Schema.optional(Schema.Boolean),
  address: Schema.optional(
    Schema.Array(Schema.suspend(() => Address)).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ),
  birthDate: Schema.optional(TimelessDateFromString),
  communication: Schema.optional(
    Schema.Array(PatientCommunication).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ),
  contact: Schema.optional(
    Schema.Array(PatientContact).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ),
  deceasedBoolean: Schema.optional(Schema.Boolean),
  deceasedDateTime: Schema.optional(Schema.DateTimeUtc),
  gender: Schema.optional(AdministrativeGender),
  generalPractitioner: Schema.optional(
    Schema.Array(Schema.suspend(() => Reference)).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ),
  identifier: Schema.optional(
    Schema.Array(Schema.suspend(() => Identifier)).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 })
    )
  ),
  link: Schema.optional(
    Schema.Array(PatientLink).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ),
  managingOrganization: Schema.optional(Schema.suspend(() => Reference)),
  maritalStatus: Schema.optional(Schema.suspend(() => CodeableConcept)),
  multipleBirthBoolean: Schema.optional(Schema.Boolean),
  multipleBirthInteger: Schema.optional(Schema.Int),
  name: Schema.optional(
    Schema.Array(Schema.suspend(() => HumanName)).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ),
  photo: Schema.optional(
    Schema.Array(Schema.suspend(() => Attachment)).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 })
    )
  ),
  telecom: Schema.optional(
    Schema.Array(Schema.suspend(() => ContactPoint)).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 })
    )
  ),
} as const satisfies Schema.Struct.Fields

const PatientResource = Resource(DomainType)

/** Encoded (wire-format) shape of a {@link Patient}. */
export interface PatientEncoded
  extends Schema.Struct.Encoded<typeof fields>, ResourceEncoded<DomainType> {}

/**
 * Demographics and other administrative information about an individual or animal
 * receiving care or other health-related services.
 */
export class Patient extends PatientResource.extend<Patient>(DomainType)(fields) {
  static readonly ResourceType = PatientResource.ResourceType
  static readonly IdSchema = PatientResource.IdSchema
  /** No search parameters configured for this resource. */
  static readonly SearchSchema = {}
  readonly cloneWith = makeCloneWith(Patient, this)
}
