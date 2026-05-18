import { State } from '@livestore/livestore'
import { Schema } from 'effect'

import { AnnotateArrayWithArbitrary, TimelessDateFromString } from 'kitchen-sink/schema'

import {
  makeDomainResourcePersistence,
  type Events as PersistenceEvents,
  type Materializers as PersistenceMaterializers,
  type PersistenceResult,
  type Table as PersistenceTable,
} from '../internal/domain-resource-persistence.ts'
import { makeRowSchemas } from '../internal/make-row-schemas.ts'
import type { RowSchemaFromFields } from '../internal/row-schema-types.ts'
import * as ChoiceElementSet from '../schemas/choice-element-set.ts'
import {
  Reference,
  Identifier,
  HumanName,
  ContactPoint,
  CodeableConcept,
  Attachment,
  AdministrativeGender,
  Address,
} from '../schemas/index.ts'
import * as DomainResource from './domain-resource.ts'
import * as PatientCommunication from './patient-communication.ts'
import * as PatientContact from './patient-contact.ts'
import * as PatientLink from './patient-link.ts'

const resourceType = 'Patient' as const

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
    schema: Schema.Array(PatientCommunication.Schema).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 })
    ),
  }),
  contact: State.SQLite.json({
    schema: Schema.Array(PatientContact.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  ...ChoiceElementSet.Columns('deceased', ChoiceElementSet.FhirR4SetChoices['Patient.deceased[x]']),
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
  ...ChoiceElementSet.Columns(
    'multipleBirth',
    ChoiceElementSet.FhirR4SetChoices['Patient.multipleBirth[x]']
  ),
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

type RowFields = {
  readonly [K in keyof typeof columns]: (typeof columns)[K]['schema']
}

type RowSchema = RowSchemaFromFields<RowFields>

type Table = PersistenceTable<typeof resourceType, RowSchema>
type Events = PersistenceEvents<typeof resourceType, RowSchema>
type Materializers = PersistenceMaterializers<typeof resourceType, RowSchema>
type Queries = PersistenceResult<typeof resourceType, RowSchema, RowSchema>['queries']

const table: Table = State.SQLite.table({ name: resourceType, columns })

const { RowSchema, RowSchemaNullableId } = makeRowSchemas(columns, { name: resourceType })

const persistence: {
  events: Events
  materializers: Materializers
  queries: Queries
} = makeDomainResourcePersistence({
  table,
  rowSchema: RowSchema,
})
const { events, materializers, queries } = persistence

export { events, materializers, queries, resourceType, RowSchema, RowSchemaNullableId, table }
export type { Events, Materializers, Queries, RowFields, Table }
export * as Communication from './patient-communication.ts'
export * as Contact from './patient-contact.ts'
export * as Link from './patient-link.ts'
