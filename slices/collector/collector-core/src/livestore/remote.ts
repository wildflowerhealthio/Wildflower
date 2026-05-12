/**
 * LiveStore bindings for collector `Remote` accounts.
 *
 * A `Remote` records a user-configured connection to an external data
 * source. The `config` column is stored as an opaque tagged JSON object so
 * the core package stays decoupled from any specific remote implementation
 * — concrete client packages (e.g. `fhir-r4-client-collector`) supply the
 * real config schemas and refine/cast at their own boundaries.
 */

import { Events, queryDb, State } from '@livestore/livestore'
import { Schema } from 'effect'

const RemoteIdSchema = Schema.String
type RemoteId = typeof RemoteIdSchema.Type

interface RemoteConfigType {
  readonly _tag: string
  readonly [key: string]: unknown
}

const RemoteConfig: Schema.Schema<RemoteConfigType> = Schema.Struct(
  { _tag: Schema.String },
  { key: Schema.String, value: Schema.Unknown }
)

const table = State.SQLite.table({
  name: 'remotes',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    name: State.SQLite.text(),
    config: State.SQLite.json({ schema: RemoteConfig }),
    addedAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
  },
})

type RemoteRow = (typeof table)['Type']

const remoteAdded = Events.synced({
  name: 'v1.RemoteAdded',
  schema: Schema.Struct({
    id: RemoteIdSchema,
    name: Schema.String,
    config: RemoteConfig,
    addedAt: Schema.DateTimeUtc,
  }),
})

const remoteUpdated = Events.synced({
  name: 'v1.RemoteUpdated',
  schema: Schema.Struct({
    id: RemoteIdSchema,
    name: Schema.String,
    config: RemoteConfig,
  }),
})

const remoteDeleted = Events.synced({
  name: 'v1.RemoteDeleted',
  schema: Schema.Struct({ id: RemoteIdSchema }),
})

const events = { remoteAdded, remoteUpdated, remoteDeleted } as const

const materializers = State.SQLite.materializers(events, {
  'v1.RemoteAdded': ({ id, name, config, addedAt }) => table.insert({ id, name, config, addedAt }),
  'v1.RemoteUpdated': ({ id, name, config }) => table.update({ name, config }).where({ id }),
  'v1.RemoteDeleted': ({ id }) => table.delete().where({ id }),
})

const all$ = queryDb(table, { label: 'remotes' })

// oxlint-disable-next-line typescript-eslint/explicit-function-return-type
const byId$ = (id: string) =>
  queryDb(table.where({ id }), { map: (rows) => rows[0], label: 'remoteById' })

const queries = { all$, byId$ } as const

export { RemoteIdSchema, RemoteConfig, table, events, materializers, queries }
export type { RemoteId, RemoteConfigType, RemoteRow }
