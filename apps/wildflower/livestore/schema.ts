import { Events, makeSchema, Schema, State } from '@livestore/livestore'
import { pipe } from 'effect'
import {
  events as fhirEvents,
  materializerDefs as fhirMaterializerDefs,
  tables as fhirTables,
} from 'fhir-r4-livestore/schema'
import { InstanceConfig } from 'fhir-r4-remote'

// --- Remote (app-level resource for connected health data sources) ---

const RemoteIdSchema = pipe(Schema.String, Schema.brand('Remote/id'))

// --- Tables ---

const remotes = State.SQLite.table({
  name: 'remotes',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    name: State.SQLite.text(),
    config: State.SQLite.json({ schema: Schema.Union(InstanceConfig) }),
    addedAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
  },
})

type RemoteRow = (typeof remotes)['Type']

const tables = {
  ...fhirTables,
  remotes,
} as const

// --- Events ---

const events = {
  ...fhirEvents,

  // Remote events
  remoteAdded: Events.synced({
    name: 'v1.RemoteAdded',
    schema: Schema.Struct({
      id: RemoteIdSchema,
      name: Schema.String,
      config: Schema.Union(InstanceConfig),
      addedAt: Schema.DateTimeUtc,
    }),
  }),
  remoteUpdated: Events.synced({
    name: 'v1.RemoteUpdated',
    schema: Schema.Struct({
      id: RemoteIdSchema,
      name: Schema.String,
      config: Schema.Union(InstanceConfig),
      addedAt: Schema.DateTimeUtc,
    }),
  }),
  remoteDeleted: Events.synced({
    name: 'v1.RemoteDeleted',
    schema: Schema.Struct({ id: RemoteIdSchema }),
  }),
}

// --- Materializers ---

const materializers = State.SQLite.materializers(events, {
  ...fhirMaterializerDefs,
  'v1.RemoteAdded': ({ id, name, config, addedAt }) =>
    tables.remotes.insert({ id, name, config, addedAt }),
  'v1.RemoteUpdated': ({ id, name, config }) =>
    tables.remotes.update({ name, config }).where({ id }),
  'v1.RemoteDeleted': ({ id }) => tables.remotes.delete().where({ id }),
})

const state = State.SQLite.makeState({ tables, materializers })

const schema = makeSchema({ events, state })

const SyncPayload = Schema.Struct({ authToken: Schema.String })

export { schema, events, tables, RemoteIdSchema, SyncPayload }
export type { RemoteRow }
