import { Events, queryDb, State } from '@livestore/livestore'
import { pipe, Schema } from 'effect'

const GrantIdSchema = pipe(Schema.String, Schema.brand('Grant/id'))

const table = State.SQLite.table({
  name: 'grants',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    clientId: State.SQLite.text(),
    scopes: State.SQLite.json({ schema: Schema.Array(Schema.String) }),
    redirectUri: State.SQLite.text(),
    grantedAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    lastUsedAt: State.SQLite.json({ schema: Schema.NullOr(Schema.DateTimeUtc) }),
    label: State.SQLite.text(),
    patient: State.SQLite.json({ schema: Schema.NullOr(Schema.String) }),
  },
})

type GrantRow = (typeof table)['Type']

const queries = {
  all$: queryDb(table, { label: 'grants' }),
  byId$: (id: string) =>
    queryDb(table.where({ id }), {
      map: (rows) => rows[0],
      label: 'grantById',
    }),
  byClientId$: (clientId: string) =>
    queryDb(table.where({ clientId }), {
      label: 'grantsByClientId',
    }),
}

const events = {
  grantUpserted: Events.synced({
    name: 'v1.GrantUpserted',
    schema: Schema.Struct({
      id: GrantIdSchema,
      clientId: Schema.String,
      scopes: Schema.Array(Schema.String),
      redirectUri: Schema.String,
      grantedAt: Schema.DateTimeUtc,
      label: Schema.String,
      patient: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
    }),
  }),
  grantRevoked: Events.synced({
    name: 'v1.GrantRevoked',
    schema: Schema.Struct({ id: GrantIdSchema }),
  }),
  // Re-housed `clientAccessRecorded` event slot — kept under the original name
  // because the rename is deferred until the consumer lands (tracked in #17).
  // Materializer points at the new `grants.lastUsedAt` column.
  clientAccessRecorded: Events.synced({
    name: 'v1.ClientAccessRecorded',
    schema: Schema.Struct({
      id: GrantIdSchema,
      lastAccessedAt: Schema.DateTimeUtc,
    }),
  }),
} as const

const materializers = {
  'v1.GrantUpserted': ({
    id,
    clientId,
    scopes,
    redirectUri,
    grantedAt,
    label,
    patient,
  }: typeof events.grantUpserted.schema.Type) =>
    table.insert({
      id,
      clientId,
      scopes,
      redirectUri,
      grantedAt,
      lastUsedAt: null,
      label,
      patient: patient ?? null,
    }),
  'v1.GrantRevoked': ({ id }: typeof events.grantRevoked.schema.Type) =>
    table.delete().where({ id }),
  'v1.ClientAccessRecorded': ({
    id,
    lastAccessedAt,
  }: typeof events.clientAccessRecorded.schema.Type) =>
    table.update({ lastUsedAt: lastAccessedAt }).where({ id }),
}

export { GrantIdSchema, table, queries, events, materializers }
export type { GrantRow }
