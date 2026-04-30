import { Schema } from 'effect'

import { AnnotateArrayWithArbitrary, TimelessDateFromString } from 'kitchen-sink/schema'

import { State } from '@livestore/livestore'
import { makeRowSchemas } from '../internal/make-row-schemas.ts'
import * as Address from '../schemas/complex/address.ts'
import { AdministrativeGender } from '../schemas/complex/administrative-gender.ts'
import * as Attachment from '../schemas/complex/attachment.ts'
import * as CodeableConcept from '../schemas/complex/codeable-concept.ts'
import * as ContactPoint from '../schemas/complex/contact-point.ts'
import * as HumanName from '../schemas/complex/human-name.ts'
import * as Identifier from '../schemas/complex/identifier.ts'
import * as Reference from '../schemas/complex/reference.ts'
import * as DomainResource from './domain-resource.ts'
import * as PatientCommunication from './patient-communication.ts'
import * as PatientContact from './patient-contact.ts'
import * as PatientLink from './patient-link.ts'

const resourceType = 'Patient' as const

const fields = {
  resourceType: Schema.Literal(resourceType),
  active: Schema.NullOr(Schema.Boolean),
  address: Schema.Array(Address.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  birthDate: Schema.NullOr(TimelessDateFromString),
  communication: Schema.NullOr(
    Schema.Array(PatientCommunication.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ),
  contact: Schema.NullOr(
    Schema.Array(PatientContact.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ),
  deceasedBoolean: Schema.NullOr(Schema.Boolean),
  deceasedDateTime: Schema.NullOr(Schema.DateTimeUtc),
  gender: Schema.NullOr(AdministrativeGender),
  generalPractitioner: Schema.Array(Reference.Schema).pipe(
    AnnotateArrayWithArbitrary({ maxLength: 2 })
  ),
  identifier: Schema.Array(Identifier.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  link: Schema.Array(PatientLink.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  managingOrganization: Schema.NullOr(Reference.Schema),
  maritalStatus: Schema.NullOr(CodeableConcept.Schema),
  multipleBirthBoolean: Schema.NullOr(Schema.Boolean),
  multipleBirthInteger: Schema.NullOr(Schema.Int),
  name: Schema.Array(HumanName.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  photo: Schema.Array(Attachment.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  telecom: Schema.Array(ContactPoint.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
} as const

const columns = {
  ...DomainResource.columns,
  resourceType: State.SQLite.text({
    default: resourceType,
    schema: Schema.Literal(resourceType),
  }),
  id: State.SQLite.text({ primaryKey: true }),
  active: State.SQLite.boolean({ nullable: true }),
  address: State.SQLite.json({
    schema: Schema.Array(Address.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  birthDate: State.SQLite.text({ nullable: true, schema: TimelessDateFromString }),
  communication: State.SQLite.json({
    nullable: true,
    schema: Schema.Array(PatientCommunication.Schema).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 })
    ),
  }),
  contact: State.SQLite.json({
    nullable: true,
    schema: Schema.Array(PatientContact.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  deceasedBoolean: State.SQLite.boolean({ nullable: true }),
  deceasedDateTime: State.SQLite.text({ nullable: true, schema: Schema.DateTimeUtc }),
  gender: State.SQLite.text({ nullable: true, schema: AdministrativeGender }),
  generalPractitioner: State.SQLite.json({
    schema: Schema.Array(Reference.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  identifier: State.SQLite.json({
    schema: Schema.Array(Identifier.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  link: State.SQLite.json({
    schema: Schema.Array(PatientLink.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  managingOrganization: State.SQLite.json({ nullable: true, schema: Reference.Schema }),
  maritalStatus: State.SQLite.json({ nullable: true, schema: CodeableConcept.Schema }),
  multipleBirthBoolean: State.SQLite.boolean({ nullable: true }),
  multipleBirthInteger: State.SQLite.integer({ nullable: true, schema: Schema.Int }),
  name: State.SQLite.json({
    schema: Schema.Array(HumanName.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  photo: State.SQLite.json({
    schema: Schema.Array(Attachment.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  telecom: State.SQLite.json({
    schema: Schema.Array(ContactPoint.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
} as const

const table = State.SQLite.table({ name: resourceType, columns })

const { RowSchema, RowSchemaOptionalId } = makeRowSchemas(columns, { name: resourceType })

export { resourceType, fields, table, RowSchema, RowSchemaOptionalId }
