import { Events, queryDb, State } from '@livestore/livestore'
import { Schema } from 'effect'

const table = State.SQLite.table({
  name: 'grants',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    clientId: State.SQLite.text(),
    scopes: State.SQLite.json({ schema: Schema.Array(Schema.String) }),
    redirectUri: State.SQLite.text(),
    grantedAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    lastUsedAt: State.SQLite.json({ schema: Schema.NullOr(Schema.DateTimeUtc) }),
    patient: State.SQLite.text({ nullable: true }),
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
  byClientIdAndRedirectUri$: (clientId: string, redirectUri: string) =>
    queryDb(table.where({ clientId, redirectUri }), {
      map: (rows): GrantRow | null => rows[0] ?? null,
      label: 'grantByClientIdAndRedirectUri',
    }),
}

const events = {
  grantCreated: Events.synced({
    name: 'v1.GrantCreated',
    schema: Schema.Struct({
      id: Schema.String,
      clientId: Schema.String,
      scopes: Schema.Array(Schema.String),
      redirectUri: Schema.String,
      grantedAt: Schema.DateTimeUtc,
      patient: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
    }),
  }),
  grantUpdated: Events.synced({
    name: 'v1.GrantUpdated',
    schema: Schema.Struct({
      id: Schema.String,
      scopes: Schema.Array(Schema.String),
      grantedAt: Schema.DateTimeUtc,
      patient: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
    }),
  }),
  grantRevoked: Events.synced({
    name: 'v1.GrantRevoked',
    schema: Schema.Struct({ id: Schema.String }),
  }),
  // Re-housed `clientAccessRecorded` event slot — kept under the original name
  // because the rename is deferred until the consumer lands (tracked in #17).
  // Materializer points at the new `grants.lastUsedAt` column.
  clientAccessRecorded: Events.synced({
    name: 'v1.ClientAccessRecorded',
    schema: Schema.Struct({
      id: Schema.String,
      lastAccessedAt: Schema.DateTimeUtc,
    }),
  }),
} as const

const materializers = {
  'v1.GrantCreated': ({
    id,
    clientId,
    scopes,
    redirectUri,
    grantedAt,
    patient,
  }: typeof events.grantCreated.schema.Type) =>
    table.insert({
      id,
      clientId,
      scopes,
      redirectUri,
      grantedAt,
      lastUsedAt: null,
      patient: patient ?? null,
    }),
  'v1.GrantUpdated': ({ id, scopes, grantedAt, patient }: typeof events.grantUpdated.schema.Type) =>
    table.update({ scopes, grantedAt, patient: patient ?? null }).where({ id }),
  'v1.GrantRevoked': ({ id }: typeof events.grantRevoked.schema.Type) =>
    table.delete().where({ id }),
  'v1.ClientAccessRecorded': ({
    id,
    lastAccessedAt,
  }: typeof events.clientAccessRecorded.schema.Type) =>
    table.update({ lastUsedAt: lastAccessedAt }).where({ id }),
}

export { table, queries, events, materializers }
export type { GrantRow }
