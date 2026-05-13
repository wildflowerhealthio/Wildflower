/**
 * LiveStore bindings for collector `Remote` accounts.
 *
 * A `Remote` records a user-configured connection to an external data
 * source. The `config` column carries the per-collector instance
 * config; the schema is the closed discriminated union assembled from
 * every collector package in `../registry.ts`. A dedicated `tag`
 * column shadows `config._tag` so SQLite-side filters
 * (`SELECT * FROM remotes WHERE tag = 'fhir-r4'`) don't have to crack
 * open the JSON. The materialiser is the single point that derives
 * `tag` from `config._tag`, so events stay shaped around the natural
 * payload and the invariant is hard to break.
 */

import { Events, queryDb, State } from '@livestore/livestore'
import { Schema } from 'effect'

import { CollectorConfig, CollectorTag } from '../registry.ts'

const table = State.SQLite.table({
  name: 'RemoteConfig',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    name: State.SQLite.text(),
    /**
     * Mirrors `config._tag` for indexed filtering. The materializer
     * derives it on insert/update so callers can't get them out of
     * sync.
     */
    tag: State.SQLite.text({ schema: CollectorTag }),
    config: State.SQLite.json({ schema: CollectorConfig }),
    addedAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
  },
})

type RemoteRow = (typeof table)['Type']

const remoteAdded = Events.synced({
  name: 'v1.RemoteConfigAdded',
  schema: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    config: CollectorConfig,
    addedAt: Schema.DateTimeUtc,
  }),
})

const remoteUpdated = Events.synced({
  name: 'v1.RemoteConfigUpdated',
  schema: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    config: CollectorConfig,
  }),
})

const remoteDeleted = Events.synced({
  name: 'v1.RemoteConfigDeleted',
  schema: Schema.Struct({ id: Schema.String }),
})

const events = { remoteAdded, remoteUpdated, remoteDeleted } as const

const materializers = State.SQLite.materializers(events, {
  'v1.RemoteConfigAdded': ({ id, name, config, addedAt }) =>
    table.insert({ id, name, tag: config._tag, config, addedAt }),
  'v1.RemoteConfigUpdated': ({ id, name, config }) =>
    table.update({ name, tag: config._tag, config }).where({ id }),
  'v1.RemoteConfigDeleted': ({ id }) => table.delete().where({ id }),
})

const all$ = queryDb(table, { label: 'remotes' })

// oxlint-disable-next-line typescript-eslint/explicit-function-return-type
const byId$ = (id: string) =>
  queryDb(table.where({ id }), { map: (rows) => rows[0], label: 'remoteById' })

// oxlint-disable-next-line typescript-eslint/explicit-function-return-type
const byTag$ = (tag: typeof CollectorTag.Type) =>
  queryDb(table.where({ tag }), { label: 'remotesByTag' })

const queries = { all$, byId$, byTag$ } as const

export { events, materializers, queries, table }
export type { RemoteRow }
