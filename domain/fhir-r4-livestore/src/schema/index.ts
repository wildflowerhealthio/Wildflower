import { Events, makeSchema, Schema, State } from '@livestore/livestore'
// Required for declaration emit — tsgo cannot name these types without an explicit import
import type { RefineSchemaId, TypeId } from 'effect/Schema'
export type { RefineSchemaId, TypeId }
import { Binary } from '../resources/Binary/binary.ts'
import { Patient } from '../resources/Patient/patient.ts'

// You can model your state as SQLite tables (https://docs.livestore.dev/reference/state/sqlite-schema)
const tables = {
  binaries: State.SQLite.table({
    name: 'binaries',
    schema: Binary.WithId,
    indexes: [
      {
        name: 'binaries_id_idx',
        columns: ['id'],
        isUnique: true,
      },
    ],
  }),
  patients: State.SQLite.table({
    name: 'patients',
    schema: Patient.WithId,
    indexes: [
      {
        name: 'patients_id_idx',
        columns: ['id'],
        isUnique: true,
      },
    ],
  }),
} as const

// Events describe data changes (https://docs.livestore.dev/reference/events)
const events = {
  binaryReceived: Events.synced({
    name: 'v1.BinaryReceived',
    schema: Schema.Struct({
      binary: Binary.WithId,
    }),
  }),
  binaryDeleted: Events.synced({
    name: 'v1.BinaryDeleted',
    schema: Schema.Struct({ id: Binary.IdSchema }),
  }),
  patientReceived: Events.synced({
    name: 'v1.PatientReceived',
    schema: Schema.Struct({
      patient: Patient.WithId,
    }),
  }),
  patientDeleted: Events.synced({
    name: 'v1.PatientDeleted',
    schema: Schema.Struct({ id: Patient.IdSchema }),
  }),
}

// Materializer definitions — exported so consuming apps can reuse them
/* oxlint-disable typescript-eslint/explicit-function-return-type */
const materializerDefs = {
  'v1.BinaryReceived': ({ binary }: { readonly binary: typeof Binary.WithId.Type }) =>
    tables.binaries.insert(binary.onlyFields()).onConflict('id', 'replace'),
  'v1.BinaryDeleted': ({ id }: { readonly id: typeof Binary.IdSchema.Type }) =>
    tables.binaries.delete().where({ id }),
  'v1.PatientReceived': ({ patient }: { readonly patient: typeof Patient.WithId.Type }) => [
    tables.patients.insert(patient.onlyFields()).onConflict('id', 'replace'),
  ],
  'v1.PatientDeleted': ({ id }: { readonly id: typeof Patient.IdSchema.Type }) =>
    tables.patients.delete().where({ id }),
}
/* oxlint-enable typescript-eslint/explicit-function-return-type */

// Materializers are used to map events to state (https://docs.livestore.dev/reference/state/materializers)
const materializers = State.SQLite.materializers(events, materializerDefs)

const state = State.SQLite.makeState({ tables, materializers })

const schema = makeSchema({ events, state })

const SyncPayload = Schema.Struct({ authToken: Schema.String })

export { schema, events, tables, materializerDefs, SyncPayload }
