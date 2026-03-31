import { Schema } from 'effect'

import {
  AnnotateArrayWithArbitrary,
  TimelessDateFromString,
  makeCloneWith,
  makeOnlyFields,
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
  active: Schema.UndefinedOr(Schema.Boolean).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  address: Schema.UndefinedOr(
    Schema.Array(Schema.suspend(() => Address)).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ).pipe(Schema.optionalWith({ default: () => undefined })),
  birthDate: Schema.UndefinedOr(TimelessDateFromString).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  communication: Schema.UndefinedOr(
    Schema.Array(PatientCommunication).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ).pipe(Schema.optionalWith({ default: () => undefined })),
  contact: Schema.UndefinedOr(
    Schema.Array(PatientContact).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ).pipe(Schema.optionalWith({ default: () => undefined })),
  deceasedBoolean: Schema.UndefinedOr(Schema.Boolean).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  deceasedDateTime: Schema.UndefinedOr(Schema.DateTimeUtc).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  gender: Schema.UndefinedOr(AdministrativeGender).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  generalPractitioner: Schema.UndefinedOr(
    Schema.Array(Schema.suspend(() => Reference)).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ).pipe(Schema.optionalWith({ default: () => undefined })),
  identifier: Schema.UndefinedOr(
    Schema.Array(Schema.suspend(() => Identifier)).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 })
    )
  ).pipe(Schema.optionalWith({ default: () => undefined })),
  link: Schema.UndefinedOr(
    Schema.Array(PatientLink).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ).pipe(Schema.optionalWith({ default: () => undefined })),
  managingOrganization: Schema.UndefinedOr(Schema.suspend(() => Reference)).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  maritalStatus: Schema.UndefinedOr(Schema.suspend(() => CodeableConcept)).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  multipleBirthBoolean: Schema.UndefinedOr(Schema.Boolean).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  multipleBirthInteger: Schema.UndefinedOr(Schema.Int).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  name: Schema.UndefinedOr(
    Schema.Array(Schema.suspend(() => HumanName)).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ).pipe(Schema.optionalWith({ default: () => undefined })),
  photo: Schema.UndefinedOr(
    Schema.Array(Schema.suspend(() => Attachment)).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 })
    )
  ).pipe(Schema.optionalWith({ default: () => undefined })),
  telecom: Schema.UndefinedOr(
    Schema.Array(Schema.suspend(() => ContactPoint)).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 })
    )
  ).pipe(Schema.optionalWith({ default: () => undefined })),
} as const satisfies Schema.Struct.Fields

const PatientResource = Resource(DomainType)

/** Encoded (wire-format) shape of a {@link Patient}. */
interface PatientEncoded
  extends Schema.Struct.Encoded<typeof fields>, ResourceEncoded<DomainType> {}

/**
 * Demographics and other administrative information about an individual or animal
 * receiving care or other health-related services.
 */
class Patient extends PatientResource.extend<Patient>(DomainType)(fields) {
  static readonly ResourceType = PatientResource.ResourceType
  static readonly IdSchema = PatientResource.IdSchema
  /** No search parameters configured for this resource. */
  static readonly SearchSchema = {}

  readonly cloneWith = makeCloneWith(Patient, this)
  readonly onlyFields = makeOnlyFields(Patient, this)

  static get WithId(): typeof PatientWithId {
    return PatientWithId
  }
}

class PatientWithId extends Patient.extend<PatientWithId>('PatientWithId')({
  id: Schema.String,
}) {}

export type { PatientEncoded }
export { Patient, PatientWithId }
