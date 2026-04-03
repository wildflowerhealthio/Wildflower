import { Events, makeSchema, Schema, State } from '@livestore/livestore'
import { Code } from '../data-types/index.ts'
import { Binary } from '../resources/Binary/binary.ts'
import { Patient } from '../resources/Patient/patient.ts'

class Account extends Schema.Class<Account>('account')({
  id: Schema.String,
  name: Schema.String,
  addedAt: Schema.DateTimeUtc,
}) {}

// You can model your state as SQLite tables (https://docs.livestore.dev/reference/state/sqlite-schema)
const tables = {
  accounts: State.SQLite.table({
    name: 'accounts',
    schema: Account,
    indexes: [
      {
        name: 'accounts_id_idx',
        columns: ['id'],
        isUnique: true,
      },
    ],
  }),
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
      id: Binary.IdSchema,
      contentType: Code,
      data: Schema.String,
      source: Schema.String,
      addedAt: Schema.DateTimeUtc,
    }),
  }),
  patientReceived: Events.synced({
    name: 'v1.PatientReceived',
    schema: Schema.Struct({
      patient: Patient.WithId,
    }),
  }),
  accountAdded: Events.synced({
    name: 'v1.AccountAdded',
    schema: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      addedAt: Schema.DateTimeUtc,
    }),
  }),
}

// Materializers are used to map events to state (https://docs.livestore.dev/reference/state/materializers)
const materializers = State.SQLite.materializers(events, {
  'v1.BinaryReceived': ({ id, contentType, data, source, addedAt }) =>
    tables.binaries
      .insert({
        id,
        resourceType: 'Binary',
        meta: {
          source,
          lastUpdated: addedAt,
          versionId: undefined,
          security: undefined,
          tag: [],
        },
        contentType,
        data,
        text: undefined,
        implicitRules: undefined,
        language: undefined,
        extension: [],
        contained: [],
        modifierExtension: [],
        securityContext: undefined,
      })
      .onConflict('id', 'replace'),
  'v1.PatientReceived': ({ patient }) => {
    return [tables.patients.insert(patient.onlyFields()).onConflict('id', 'replace')]
  },
  'v1.AccountAdded': ({ id, name, addedAt }) => tables.accounts.insert({ id, name, addedAt }),
})

const state = State.SQLite.makeState({ tables, materializers })

const schema = makeSchema({ events, state })

const SyncPayload = Schema.Struct({ authToken: Schema.String })

export { schema, events, tables, SyncPayload }
