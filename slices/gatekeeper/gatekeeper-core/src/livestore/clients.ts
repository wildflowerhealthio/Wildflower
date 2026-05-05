import { Events, queryDb, State } from '@livestore/livestore'
import { pipe, Schema } from 'effect'

const ClientIdSchema = pipe(Schema.String, Schema.brand('Client/id'))

const table = State.SQLite.table({
  name: 'clients',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    clientId: State.SQLite.text(),
    type: State.SQLite.text(),
    scopes: State.SQLite.json({ schema: Schema.Array(Schema.String) }),
    redirectUri: State.SQLite.json({ schema: Schema.NullOr(Schema.String) }),
    approvedAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    lastAccessedAt: State.SQLite.json({ schema: Schema.NullOr(Schema.DateTimeUtc) }),
    label: State.SQLite.text(),
    patient: State.SQLite.json({ schema: Schema.NullOr(Schema.String) }),
  },
})

type ClientRow = (typeof table)['Type']

const queries = {
  all$: queryDb(table, { label: 'clients' }),
  byId$: (id: string) =>
    queryDb(table.where({ id }), {
      map: (rows) => rows[0],
      label: 'clientById',
    }),
  byClientId$: (clientId: string) =>
    queryDb(table.where({ clientId }), {
      label: 'clientByClientId',
    }),
}

const events = {
  clientApproved: Events.synced({
    name: 'v1.ClientApproved',
    schema: Schema.Struct({
      id: ClientIdSchema,
      clientId: Schema.String,
      type: Schema.Literal('oauth', 'ip', 'pin'),
      scopes: Schema.Array(Schema.String),
      redirectUri: Schema.optionalWith(Schema.String, { default: () => '' }),
      approvedAt: Schema.DateTimeUtc,
      label: Schema.String,
      patient: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
    }),
  }),
  clientRevoked: Events.synced({
    name: 'v1.ClientRevoked',
    schema: Schema.Struct({ id: ClientIdSchema }),
  }),
  clientAccessRecorded: Events.synced({
    name: 'v1.ClientAccessRecorded',
    schema: Schema.Struct({
      id: ClientIdSchema,
      lastAccessedAt: Schema.DateTimeUtc,
    }),
  }),
} as const

const materializers = {
  'v1.ClientApproved': ({
    id,
    clientId,
    type,
    scopes,
    redirectUri,
    approvedAt,
    label,
    patient,
  }: typeof events.clientApproved.schema.Type) =>
    table.insert({
      id,
      clientId,
      type,
      scopes,
      redirectUri: redirectUri || null,
      approvedAt,
      lastAccessedAt: null,
      label,
      patient: patient ?? null,
    }),
  'v1.ClientRevoked': ({ id }: typeof events.clientRevoked.schema.Type) =>
    table.delete().where({ id }),
  'v1.ClientAccessRecorded': ({
    id,
    lastAccessedAt,
  }: typeof events.clientAccessRecorded.schema.Type) =>
    table.update({ lastAccessedAt }).where({ id }),
}

export { ClientIdSchema, table, queries, events, materializers }
export type { ClientRow }
