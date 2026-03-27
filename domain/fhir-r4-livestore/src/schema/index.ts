import { Events, makeSchema, Schema, State } from '@livestore/livestore'

// You can model your state as SQLite tables (https://docs.livestore.dev/reference/state/sqlite-schema)
const tables = {
  accounts: State.SQLite.table({
    name: 'accounts',
    columns: {
      id: State.SQLite.text({ primaryKey: true }),
      addedAt: State.SQLite.integer({ nullable: true, schema: Schema.DateFromNumber }),
      name: State.SQLite.text({}),
    },
  }),
  patients: State.SQLite.table({
    name: 'patients',
    columns: {
      id: State.SQLite.text({ primaryKey: true }),
      fhirJson: State.SQLite.json({}),
      raw: State.SQLite.text({}),
    },
  }),
}

// Events describe data changes (https://docs.livestore.dev/reference/events)
const events = {
  patientReceived: Events.synced({
    name: 'v1.PatientReceived',
    schema: Schema.Struct({
      id: Schema.String,
      fhirJson: Schema.Any,
      raw: Schema.String,
    }),
  }),
  accountAdded: Events.synced({
    name: 'v1.AccountAdded',
    schema: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      addedAt: Schema.Date,
    }),
  }),
}

// Materializers are used to map events to state (https://docs.livestore.dev/reference/state/materializers)
const materializers = State.SQLite.materializers(events, {
  'v1.PatientReceived': ({ id, fhirJson, raw }) => tables.patients.insert({ id, fhirJson, raw }),
  'v1.AccountAdded': ({ id, name, addedAt }) => tables.accounts.insert({ id, name, addedAt }),
})

const state = State.SQLite.makeState({ tables, materializers })

const schema = makeSchema({ events, state })

const SyncPayload = Schema.Struct({ authToken: Schema.String })

export { schema, events, tables, SyncPayload }
